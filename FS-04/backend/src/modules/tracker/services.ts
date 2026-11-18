import type { WorkflowStatus } from "../../generated/prisma/client.js";
import { lockRow, Prisma, type Tx } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";

const DEFAULT_STATUSES = [
  { name: "To Do", category: "todo", color: "#64748b" },
  { name: "In Progress", category: "in_progress", color: "#2563eb" },
  { name: "In Review", category: "in_progress", color: "#9333ea" },
  { name: "Done", category: "done", color: "#16a34a" },
] as const;

// Every workspace starts with this workflow: a linear flow with the ability to step back; Done reopens to To Do.
export async function createDefaultWorkflow(tx: Tx, workspaceId: number) {
  const wf = await tx.workflow.create({ data: { workspaceId, name: "Default workflow", isDefault: true } });
  const statuses: WorkflowStatus[] = [];
  for (const [order, s] of DEFAULT_STATUSES.entries()) {
    statuses.push(await tx.workflowStatus.create({ data: { workspaceId, workflowId: wf.id, order, ...s } }));
  }
  const pairs: Array<[WorkflowStatus, WorkflowStatus]> = [];
  for (let i = 0; i < statuses.length - 1; i++) pairs.push([statuses[i]!, statuses[i + 1]!], [statuses[i + 1]!, statuses[i]!]);
  pairs.push([statuses.at(-1)!, statuses[0]!]);
  await tx.workflowTransition.createMany({
    data: pairs.map(([a, b]) => ({ workspaceId, workflowId: wf.id, fromStatusId: a.id, toStatusId: b.id })),
  });
  return wf;
}

export async function defaultWorkflow(tx: Tx, workspaceId: number) {
  return (
    (await tx.workflow.findFirst({ where: { workspaceId, isDefault: true } })) ?? createDefaultWorkflow(tx, workspaceId)
  );
}

// A workflow with no transition rules allows every move; otherwise only the listed ones.
export async function canTransition(tx: Tx, workflowId: number, fromId: number | null, toId: number): Promise<boolean> {
  if (fromId === null || fromId === toId) return true;
  const rules = await tx.workflowTransition.count({ where: { workflowId } });
  if (rules === 0) return true;
  return (await tx.workflowTransition.count({ where: { workflowId, fromStatusId: fromId, toStatusId: toId } })) > 0;
}

// Statuses in board order.
export const statusOrder = [{ order: "asc" as const }, { id: "asc" as const }];

export interface NewIssue {
  projectId: number;
  statusId?: number;
  [field: string]: unknown;
}

// Next issue number for the project (the project row is locked, so two creates never share a number) and a place
// at the bottom of the issue's column.
export async function numberAndRank(tx: Tx, projectId: number, statusId: number | undefined) {
  await lockRow(tx, "projects", projectId);
  const project = await tx.project.update({ where: { id: projectId }, data: { issueCounter: { increment: 1 } } });
  const status =
    statusId ??
    (await tx.workflowStatus.findFirstOrThrow({ where: { workflowId: project.workflowId }, orderBy: statusOrder })).id;
  const last = await tx.issue.findFirst({
    where: { projectId, statusId: status },
    orderBy: { rank: "desc" },
    select: { rank: true },
  });
  return { number: project.issueCounter, statusId: status, rank: last ? last.rank + 1000 : 1000 };
}

// Move an issue to `toStatusId` at a position within that column, enforcing the workflow's rules.
// The position is right after / before a neighbour's id when given (a filtered board only sees some cards, so a
// neighbour is the reliable reference), otherwise `index`; nothing puts it at the bottom. The issue's row is locked
// and its status re-read first, so two simultaneous moves of the same card are checked one after the other.
export async function moveIssue(
  tx: Tx,
  issueId: number,
  toStatusId: number,
  position: { index?: number; after?: number; before?: number } = {},
) {
  await lockRow(tx, "issues", issueId);
  const issue = await tx.issue.findUniqueOrThrow({
    where: { id: issueId },
    include: { status: true, project: { select: { workflowId: true } } },
  });
  const to = await tx.workflowStatus.findUniqueOrThrow({ where: { id: toStatusId } });
  if (to.workflowId !== issue.project.workflowId) {
    throw badRequest({ status: "Status does not belong to this project's workflow." });
  }
  if (!(await canTransition(tx, issue.project.workflowId, issue.statusId, to.id))) {
    throw badRequest({ status: `Transition '${issue.status.name}' → '${to.name}' is not allowed by the workflow.` });
  }
  const column = await tx.$queryRaw<{ id: number }[]>`
    SELECT id FROM issues WHERE "projectId" = ${issue.projectId} AND "statusId" = ${to.id} AND id <> ${issue.id}
    ORDER BY rank, id FOR UPDATE`;
  const ids = column.map((r) => r.id);
  let index = position.index;
  if (position.after !== undefined && ids.includes(position.after)) index = ids.indexOf(position.after) + 1;
  else if (position.before !== undefined && ids.includes(position.before)) index = ids.indexOf(position.before);
  if (index === undefined || index > ids.length) index = ids.length;
  ids.splice(Math.max(index, 0), 0, issue.id);
  await tx.issue.update({ where: { id: issue.id }, data: { statusId: to.id, rank: (ids.indexOf(issue.id) + 1) * 1000 } });
  const others = ids.map((id, i) => [id, (i + 1) * 1000] as const).filter(([id]) => id !== issue.id);
  if (others.length) {
    const values = Prisma.join(others.map(([id, rank]) => Prisma.sql`(${id}::int, ${rank}::float8)`));
    await tx.$executeRaw`UPDATE issues SET rank = v.rank FROM (VALUES ${values}) AS v(id, rank) WHERE issues.id = v.id`;
  }
  return { from: issue.status, to };
}
