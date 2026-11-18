import { Router, type Request } from "express";
import type { AuditLog } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { addDays, iso, queryString, routeId } from "../../lib/http.js";
import { need, useWorkspace, ws } from "../tenancy/context.js";
import { own, sendPage } from "../tracker/common.js";

// The audit log page (admins and the owner). Read-only: entries are never changed or deleted through the API.

// The issue History tab (every role) leaves out where each change came from; the admin log includes it.
export const auditOut = (e: AuditLog, withIp = true) => ({
  id: e.id,
  action: e.action,
  entity_type: e.entityType,
  entity_id: e.entityId,
  entity_label: e.entityLabel,
  changes: e.changes,
  actor_email: e.actorEmail,
  created_at: iso(e.createdAt),
  ...(withIp && { ip_address: e.ipAddress }),
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// ?action, ?entity_type, ?entity_id, ?kind (the part before the dot: issue, member, billing…), ?actor_email,
// ?since / ?until (UTC days, inclusive), ?search.
function filters(req: Request) {
  const where: Record<string, unknown> = { workspaceId: ws(req).id };
  const action = queryString(req, "action");
  const entityType = queryString(req, "entity_type");
  const entityId = queryString(req, "entity_id");
  const kind = queryString(req, "kind");
  const actor = queryString(req, "actor_email");
  const since = queryString(req, "since");
  const until = queryString(req, "until");
  const search = queryString(req, "search");
  for (const [name, value] of [["since", since], ["until", until]] as const) {
    if (value && !DATE.test(value)) throw badRequest({ [name]: "Enter a valid date." });
  }
  const and: object[] = [];
  if (action) where.action = action;
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (kind) and.push({ action: { startsWith: `${kind}.` } });
  if (actor) where.actorEmail = { equals: actor, mode: "insensitive" };
  const created: Record<string, Date> = {};
  if (since) created.gte = new Date(`${since}T00:00:00Z`);
  if (until) created.lt = addDays(new Date(`${until}T00:00:00Z`), 1);
  if (since || until) where.createdAt = created;
  if (search) {
    and.push({
      OR: ["entityLabel", "action", "actorEmail"].map((f) => ({ [f]: { contains: search, mode: "insensitive" } })),
    });
  }
  if (and.length) where.AND = and;
  return where;
}

const NEWEST = [{ createdAt: "desc" as const }, { id: "desc" as const }];
const EXPORT_LIMIT = 10_000;

// Spreadsheet apps would run a cell starting with = + - @ as a formula; labels like issue titles are user-written.
export function csvSafe(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);

export function auditRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  r.use((req, _res, next) => (need(req, "admin"), next()));

  r.get("/", (req, res) => sendPage(req, res, prisma.auditLog, filters(req), NEWEST, (e: AuditLog) => auditOut(e)));

  // The filtered log as CSV (newest first, up to 10,000 rows). Same filters as the list.
  r.get("/export/", async (req, res) => {
    const rows = await prisma.auditLog.findMany({ where: filters(req), orderBy: NEWEST, take: EXPORT_LIMIT });
    const lines = [["time (UTC)", "who", "action", "entity type", "entity id", "entity", "changes", "ip address"]];
    for (const e of rows) {
      const changes = e.changes && Object.keys(e.changes as object).length ? JSON.stringify(e.changes) : "";
      lines.push([
        e.createdAt.toISOString().slice(0, 19) + "+00:00", csvSafe(e.actorEmail || "system"), e.action, e.entityType,
        e.entityId, csvSafe(e.entityLabel), csvSafe(changes), e.ipAddress ?? "",
      ]);
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="audit-log-${ws(req).slug}.csv"`);
    res.send(lines.map((l) => l.map(csvCell).join(",")).join("\r\n") + "\r\n");
  });

  r.get("/:id/", async (req, res) => {
    res.json(auditOut(await own(prisma.auditLog.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id } }))));
  });
  return r;
}
