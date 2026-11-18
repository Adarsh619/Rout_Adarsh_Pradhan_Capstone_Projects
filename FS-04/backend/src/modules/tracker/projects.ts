import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { inTransaction, isUniqueViolation, lockRow, prisma } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { queryChoice, queryInt, queryString, routeId, toDate } from "../../lib/http.js";
import { dateOnly, id, optionalId, parse, patchOf, required, text } from "../../lib/validate.js";
import { entity } from "../audit/entities.js";
import { diff, record } from "../audit/service.js";
import { enforceLimit } from "../billing/limits.js";
import { need, useWorkspace, ws } from "../tenancy/context.js";
import { fixedOnUpdate, memberRef, own, ref, sendPage } from "./common.js";
import { deleteAttachmentFiles } from "./files.js";
import { boardOut, issueOut, type IssueRow, projectOut, sprintOut, statusOut } from "./serialize.js";

const cardInclude = { assignee: true, reporter: true, _count: { select: { comments: true } } } as const;
import { defaultWorkflow, statusOrder } from "./services.js";

// ── Projects (everyone reads; admins write) ───────────────────────────────────────────────────────────────────
const projectShape = {
  key: z.string().trim().min(1).max(10),
  name: required(120),
  description: text(),
  workflow: id,
  lead: optionalId,
};
const projectBody = z.object({ ...projectShape, description: text().default(""), workflow: id.optional() });
const projectPatch = patchOf(projectShape);
const projectInclude = { _count: { select: { issues: true } }, boards: { select: { id: true } } } as const;

async function checkKey(req: Request, key: string, exceptId?: number): Promise<string> {
  const upper = key.toUpperCase();
  // ASCII only, so "É" or "²" can't sneak into issue keys.
  if (!/^[A-Z0-9]+$/.test(upper)) throw badRequest({ key: "Key must be letters A–Z and digits 0–9 only." });
  const clash = await prisma.project.findFirst({ where: { workspaceId: ws(req).id, key: upper, ...(exceptId && { id: { not: exceptId } }) } });
  if (clash) throw badRequest({ key: "A project with this key already exists in the workspace." });
  return upper;
}

async function projectFiles(projectId: number) {
  return (await prisma.attachment.findMany({ where: { issue: { projectId } }, select: { file: true } })).map((a) => a.file);
}

export function projectsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.project.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: projectInclude }));

  r.get("/", (req, res) => {
    const search = queryString(req, "search");
    const where = {
      workspaceId: ws(req).id,
      ...(search && { OR: [{ name: { contains: search, mode: "insensitive" as const } }, { key: { contains: search, mode: "insensitive" as const } }] }),
    };
    return sendPage(req, res, prisma.project, where, [{ name: "asc" }, { id: "asc" }], projectOut, projectInclude);
  });
  r.get("/:id/", async (req, res) => {
    res.json(projectOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(projectBody, req.body);
    const wsId = ws(req).id;
    const key = await checkKey(req, data.key);
    if (data.workflow !== undefined) await ref(prisma, "workflow", data.workflow, wsId, "workflow");
    if (data.lead) await memberRef(prisma, data.lead, wsId, "lead");
    try {
      const project = await inTransaction(async (unit) => {
        // The limit check and the new project are one step (see enforceLimit).
        await enforceLimit(unit.tx, wsId, "projects");
        const workflowId = data.workflow ?? (await defaultWorkflow(unit.tx, wsId)).id;
        const p = await unit.tx.project.create({
          data: { workspaceId: wsId, key, name: data.name, description: data.description, workflowId, leadId: data.lead ?? null },
        });
        await unit.tx.board.create({ data: { workspaceId: wsId, projectId: p.id, name: `${key} board` } });
        await record(unit, req, "project.created", entity.project(p));
        return unit.tx.project.findUniqueOrThrow({ where: { id: p.id }, include: projectInclude });
      });
      res.status(201).json(projectOut(project));
    } catch (err) {
      if (isUniqueViolation(err)) throw badRequest({ key: "A project with this key already exists in the workspace." });
      throw err;
    }
  });

  const update = async (req: Request, res: Response) => {
    need(req, "admin");
    const p = await find(req);
    const data = parse(projectPatch, req.body);
    const wsId = ws(req).id;
    if (data.key !== undefined) data.key = await checkKey(req, data.key, p.id);
    if (data.workflow !== undefined) {
      await ref(prisma, "workflow", data.workflow, wsId, "workflow");
      if (data.workflow !== p.workflowId && p._count.issues) {
        throw badRequest({ workflow: "Cannot change workflow of a project that already has issues." });
      }
    }
    if (data.lead) await memberRef(prisma, data.lead, wsId, "lead");
    const changes = diff(
      { key: p.key, name: p.name, description: p.description, workflow: p.workflowId, lead: p.leadId },
      data,
    );
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.project.update({
        where: { id: p.id },
        data: {
          key: data.key, name: data.name, description: data.description, workflowId: data.workflow,
          ...(data.lead !== undefined && { leadId: data.lead }),
        },
        include: projectInclude,
      });
      if (Object.keys(changes).length) await record(unit, req, "project.updated", entity.project(u), changes);
      return u;
    });
    res.json(projectOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const p = await find(req);
    const files = await projectFiles(p.id);
    await inTransaction(async (unit) => {
      await record(unit, req, "project.deleted", entity.project(p));
      await unit.tx.project.delete({ where: { id: p.id } });
    });
    await deleteAttachmentFiles(files);
    res.status(204).end();
  });

  r.get("/:id/stats/", async (req, res) => {
    const p = await find(req);
    const [byStatus, byPriority, byType, statuses] = await Promise.all([
      prisma.issue.groupBy({ by: ["statusId"], where: { projectId: p.id }, _count: { _all: true } }),
      prisma.issue.groupBy({ by: ["priority"], where: { projectId: p.id }, _count: { _all: true } }),
      prisma.issue.groupBy({ by: ["type"], where: { projectId: p.id }, _count: { _all: true } }),
      prisma.workflowStatus.findMany({ where: { workspaceId: ws(req).id }, select: { id: true, category: true } }),
    ]);
    const category = new Map(statuses.map((s) => [s.id, s.category]));
    const byCategory: Record<string, number> = { todo: 0, in_progress: 0, done: 0 };
    for (const row of byStatus) byCategory[category.get(row.statusId)!]! += row._count._all;
    res.json({
      total: Object.values(byCategory).reduce((a, b) => a + b, 0),
      by_category: byCategory,
      by_priority: Object.fromEntries(byPriority.map((row) => [row.priority, row._count._all])),
      by_type: Object.fromEntries(byType.map((row) => [row.type, row._count._all])),
    });
  });
  return r;
}

// ── Boards ────────────────────────────────────────────────────────────────────────────────────────────────────
const boardBody = z.object({ project: id, name: required(100), kind: z.enum(["kanban", "scrum"]).default("kanban") });
const boardPatch = patchOf({ project: id, name: required(100), kind: z.enum(["kanban", "scrum"]) });

export function boardsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) => own(prisma.board.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id } }));

  r.get("/", (req, res) => {
    const projectId = queryInt(req, "project");
    return sendPage(req, res, prisma.board, { workspaceId: ws(req).id, ...(projectId !== undefined && { projectId }) },
      { id: "asc" }, boardOut);
  });
  r.get("/:id/", async (req, res) => {
    res.json(boardOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(boardBody, req.body);
    await ref(prisma, "project", data.project, ws(req).id, "project");
    const board = await inTransaction(async (unit) => {
      const b = await unit.tx.board.create({ data: { workspaceId: ws(req).id, projectId: data.project, name: data.name, kind: data.kind } });
      await record(unit, req, "board.created", entity.board(b));
      return b;
    });
    res.status(201).json(boardOut(board));
  });

  const update = async (req: Request, res: Response) => {
    need(req, "admin");
    const b = await find(req);
    const data = parse(boardPatch, req.body);
    if (data.project !== undefined) await ref(prisma, "project", data.project, ws(req).id, "project");
    fixedOnUpdate(data, { project: b.projectId });
    const fields = { name: data.name, kind: data.kind };
    const changes = diff({ name: b.name, kind: b.kind }, fields);
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.board.update({ where: { id: b.id }, data: fields });
      if (Object.keys(changes).length) await record(unit, req, "board.updated", entity.board(u), changes);
      return u;
    });
    res.json(boardOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const b = await find(req);
    await inTransaction(async (unit) => {
      await record(unit, req, "board.deleted", entity.board(b));
      await unit.tx.board.delete({ where: { id: b.id } });
    });
    res.status(204).end();
  });

  // Board columns = the statuses of the project's workflow, each with its ordered issues.
  // ?sprint=<id>|active|backlog|all, ?assignee=<id>, ?q=<text>. Scrum boards default to the active sprint,
  // Kanban boards to every issue. A fixed number of queries, however many issues there are.
  r.get("/:id/columns/", async (req, res) => {
    const { project, ...b } = await own(
      prisma.board.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: { project: true } }),
    );
    const sprint = queryString(req, "sprint");
    const assignee = queryString(req, "assignee");
    if (sprint !== undefined && !["active", "backlog", "all"].includes(sprint) && !/^\d+$/.test(sprint)) {
      throw badRequest({ sprint: "Use a sprint id, active, backlog or all." });
    }
    if (assignee !== undefined && !/^\d+$/.test(assignee)) throw badRequest({ assignee: "Use a user id." });
    const active = await prisma.sprint.findFirst({ where: { projectId: project.id, state: "active" }, include: { _count: { select: { issues: true } } } });
    const where: Record<string, unknown> = { workspaceId: ws(req).id, projectId: project.id };
    let none = false;
    if (sprint === "active" || (sprint === undefined && b.kind === "scrum")) {
      if (active) where.sprintId = active.id;
      else none = true;
    } else if (sprint === "backlog") where.sprintId = null;
    else if (sprint && sprint !== "all") where.sprintId = Number(sprint);
    if (assignee) where.assigneeId = Number(assignee);
    const q = queryString(req, "q");
    if (q) where.title = { contains: q, mode: "insensitive" };
    const [issues, statuses, transitions] = await Promise.all([
      // The statuses and the project are already loaded, so only the people are fetched with the issues.
      none ? Promise.resolve([]) : prisma.issue.findMany({ where, include: cardInclude, orderBy: [{ rank: "asc" }, { id: "asc" }] }),
      prisma.workflowStatus.findMany({ where: { workflowId: project.workflowId }, orderBy: statusOrder }),
      prisma.workflowTransition.findMany({ where: { workflowId: project.workflowId }, orderBy: { id: "asc" } }),
    ]);
    const statusById = new Map(statuses.map((st) => [st.id, st]));
    const byStatus = new Map<number, IssueRow[]>();
    for (const issue of issues) {
      const row = { ...issue, project: { key: project.key }, status: statusById.get(issue.statusId)! };
      byStatus.set(issue.statusId, [...(byStatus.get(issue.statusId) ?? []), row]);
    }
    res.json({
      board: boardOut(b),
      project: { id: project.id, key: project.key, name: project.name },
      active_sprint: active ? sprintOut(active) : null,
      transitions: transitions.map((t) => ({ from_status: t.fromStatusId, to_status: t.toStatusId })),
      columns: statuses.map((s) => ({
        status: statusOut(s),
        issues: (byStatus.get(s.id) ?? []).map((i) => issueOut(i, req.membership)),
      })),
    });
  });
  return r;
}

// ── Sprints ───────────────────────────────────────────────────────────────────────────────────────────────────
const sprintShape = {
  project: id,
  name: required(100),
  goal: text(),
  start_date: dateOnly.nullable(),
  end_date: dateOnly.nullable(),
};
const sprintBody = z.object({ ...sprintShape, goal: text().default(""), start_date: dateOnly.nullable().optional(), end_date: dateOnly.nullable().optional() });
const sprintPatch = patchOf(sprintShape);
const sprintInclude = { _count: { select: { issues: true } } } as const;
const ACTIVE_CLASH = "This project already has an active sprint.";

function checkDates(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start) throw badRequest({ end_date: "End date must be after start date." });
}

export function sprintsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.sprint.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: sprintInclude }));

  r.get("/", (req, res) => {
    const projectId = queryInt(req, "project");
    const state = queryChoice(req, "state", ["planned", "active", "closed"] as const);
    return sendPage(req, res, prisma.sprint,
      { workspaceId: ws(req).id, ...(projectId !== undefined && { projectId }), ...(state && { state }) },
      [{ createdAt: "desc" }, { id: "desc" }], sprintOut, sprintInclude);
  });
  r.get("/:id/", async (req, res) => {
    res.json(sprintOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(sprintBody, req.body);
    await ref(prisma, "project", data.project, ws(req).id, "project");
    checkDates(data.start_date, data.end_date);
    const sprint = await inTransaction(async (unit) => {
      const s = await unit.tx.sprint.create({
        data: {
          workspaceId: ws(req).id, projectId: data.project, name: data.name, goal: data.goal,
          startDate: toDate(data.start_date) ?? null, endDate: toDate(data.end_date) ?? null,
        },
        include: sprintInclude,
      });
      await record(unit, req, "sprint.created", entity.sprint(s));
      return s;
    });
    res.status(201).json(sprintOut(sprint));
  });

  const update = async (req: Request, res: Response) => {
    need(req, "admin");
    const s = await find(req);
    const data = parse(sprintPatch, req.body);
    if (data.project !== undefined) await ref(prisma, "project", data.project, ws(req).id, "project");
    fixedOnUpdate(data, { project: s.projectId });
    // On PATCH only one date may be sent; compare it with the one already saved.
    const saved = sprintOut(s);
    checkDates(data.start_date === undefined ? saved.start_date : data.start_date, data.end_date === undefined ? saved.end_date : data.end_date);
    const fields = { name: data.name, goal: data.goal, start_date: data.start_date, end_date: data.end_date };
    const changes = diff({ name: s.name, goal: s.goal, start_date: saved.start_date, end_date: saved.end_date }, fields);
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.sprint.update({
        where: { id: s.id },
        data: { name: data.name, goal: data.goal, startDate: toDate(data.start_date), endDate: toDate(data.end_date) },
        include: sprintInclude,
      });
      if (Object.keys(changes).length) await record(unit, req, "sprint.updated", entity.sprint(u), changes);
      return u;
    });
    res.json(sprintOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const s = await find(req);
    await inTransaction(async (unit) => {
      await record(unit, req, "sprint.deleted", entity.sprint(s));
      await unit.tx.sprint.delete({ where: { id: s.id } });
    });
    res.status(204).end();
  });

  r.post("/:id/start/", async (req, res) => {
    need(req, "admin");
    const s = await find(req);
    if (s.state !== "planned") throw badRequest("Only planned sprints can be started.");
    if (await prisma.sprint.count({ where: { projectId: s.projectId, state: "active" } })) throw badRequest(ACTIVE_CLASH);
    try {
      const started = await inTransaction(async (unit) => {
        // Two Start clicks can both pass the check above; the one-active-sprint index stops the second.
        const u = await unit.tx.sprint.update({ where: { id: s.id }, data: { state: "active" }, include: sprintInclude });
        await record(unit, req, "sprint.started", entity.sprint(u));
        return u;
      });
      res.json(sprintOut(started));
    } catch (err) {
      if (isUniqueViolation(err)) throw badRequest(ACTIVE_CLASH);
      throw err;
    }
  });

  // One transaction: unfinished issues return to the backlog and the sprint closes together, or neither happens.
  r.post("/:id/complete/", async (req, res) => {
    need(req, "admin");
    const s = await find(req);
    const result = await inTransaction(async (unit) => {
      await lockRow(unit.tx, "sprints", s.id);
      const current = await unit.tx.sprint.findUniqueOrThrow({ where: { id: s.id } });
      if (current.state !== "active") throw badRequest("Only active sprints can be completed.");
      const moved = await unit.tx.issue.updateMany({
        where: { sprintId: s.id, status: { category: { not: "done" } } },
        data: { sprintId: null },
      });
      const closed = await unit.tx.sprint.update({ where: { id: s.id }, data: { state: "closed" }, include: sprintInclude });
      await record(unit, req, "sprint.completed", entity.sprint(closed), { returned_to_backlog: moved.count });
      return { sprint: sprintOut(closed), returned_to_backlog: moved.count };
    });
    res.json(result);
  });
  return r;
}
