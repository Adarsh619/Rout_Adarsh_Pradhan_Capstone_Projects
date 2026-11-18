import type { Request, Response } from "express";
import { prisma, type Tx } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { pageOf, paginated } from "../../lib/http.js";

// Shared pieces of the tracker routes: tenant-checked references and paginated lists.

const missing = (field: string, value: unknown) => badRequest({ [field]: `Invalid pk "${String(value)}" - object does not exist.` });

type Tables = "workflow" | "workflowStatus" | "project" | "sprint" | "issue";

// A referenced row (e.g. the issue's sprint) must exist in the current workspace; anything else is reported as
// not existing, so ids from another company reveal nothing.
export async function ref<T extends Tables>(tx: Tx, table: T, id: number, workspaceId: number, field: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row = await (tx[table] as any).findFirst({ where: { id, workspaceId } });
  if (!row) throw missing(field, id);
  return row as NonNullable<Awaited<ReturnType<Tx[T]["findFirst"]>>>;
}

// A user referenced by id (assignee, project lead) must be a member of the current workspace.
export async function memberRef(tx: Tx, userId: number, workspaceId: number, field: string) {
  const m = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId } } });
  if (!m) throw missing(field, userId);
  return m;
}

// Find a row of the current workspace by the route's id, or 404.
export async function own<T>(find: Promise<T | null>): Promise<T> {
  const row = await find;
  if (!row) throw notFound();
  return row;
}

// Any Prisma model delegate (the rows' shape comes from `include`, so it is typed by `out`).
interface Lister {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count(args: any): PromiseLike<number>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  findMany(args: any): PromiseLike<any[]>;
}

// Send one page of `model` rows matching `where`, mapped through `out`.
export async function sendPage<Row, Out>(
  req: Request,
  res: Response,
  model: Lister,
  where: object,
  orderBy: object | object[],
  out: (row: Row) => Out,
  include?: object,
) {
  const page = pageOf(req);
  const [count, rows] = await Promise.all([
    model.count({ where }),
    model.findMany({ where, orderBy, skip: page.offset, take: page.limit, ...(include ? { include } : {}) }),
  ]);
  res.json(paginated(req, page, count, rows.map(out)));
}

// Fields that are set at creation only. Moving a status to another workflow, or a sprint/board/comment to another
// parent, would leave the rows pointing at it inconsistent. Resending the current value is fine.
export function fixedOnUpdate(data: Record<string, unknown>, current: Record<string, unknown>) {
  for (const [field, value] of Object.entries(current)) {
    if (data[field] !== undefined && data[field] !== value) throw badRequest({ [field]: "Can't be changed after creation." });
  }
}

export { prisma };
