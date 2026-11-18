import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Unit } from "../../lib/db.js";
import { inTransaction, lockRow, prisma } from "../../lib/db.js";
import { badRequest, forbidden, invalid } from "../../lib/errors.js";
import { day, ordering, queryChoice, queryInt, queryString, routeId, toDate } from "../../lib/http.js";
import { dateOnly, id, optionalId, parse, patchOf, required, text } from "../../lib/validate.js";
import { entity } from "../audit/entities.js";
import { auditOut } from "../audit/routes.js";
import { diff, record } from "../audit/service.js";
import { currentUser } from "../auth/middleware.js";
import { enforceLimit } from "../billing/limits.js";
import { notifyIssueEvent, notifyWorkspaceAdmins } from "../integrations/notify.js";
import { hasRole, need, useWorkspace, ws } from "../tenancy/context.js";
import { fixedOnUpdate, memberRef, own, ref, sendPage } from "./common.js";
import { deleteAttachmentFiles } from "./files.js";
import { canDeleteIssue, commentOut, issueInclude, issueKey, issueOut, type IssueRow } from "./serialize.js";
import { canTransition, moveIssue, numberAndRank } from "./services.js";

const TYPES = ["task", "bug", "story", "epic"] as const;
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

const issueShape = {
  project: id,
  title: required(255),
  description: text(),
  type: z.enum(TYPES),
  priority: z.enum(PRIORITIES),
  status: id,
  sprint: optionalId,
  assignee: optionalId,
  story_points: z.coerce.number().int().min(0).max(32767).nullable(),
  due_date: dateOnly.nullable(),
};
const issueBody = z.object({
  ...issueShape,
  description: text().default(""),
  type: z.enum(TYPES).default("task"),
  priority: z.enum(PRIORITIES).default("medium"),
  status: id.optional(),
  story_points: issueShape.story_points.optional(),
  due_date: issueShape.due_date.optional(),
});
const issuePatch = patchOf(issueShape);
const moveBody = z.object({
  status: id,
  index: z.coerce.number().int().min(0).optional(),
  // Neighbour issue ids; only looked up among the target column's issues, so other ids are just ignored.
  after: z.coerce.number().int().optional(),
  before: z.coerce.number().int().optional(),
});

const ORDERING = ["created_at", "updated_at", "priority", "rank", "due_date"] as const;
const ORDER_FIELD: Record<string, string> = { created_at: "createdAt", updated_at: "updatedAt", priority: "priority", rank: "rank", due_date: "dueDate" };

async function loadIssue(id: number): Promise<IssueRow> {
  return prisma.issue.findUniqueOrThrow({ where: { id }, include: issueInclude });
}

// Checks shared by create and update: every reference in the workspace, the status in the project's workflow,
// the sprint in the same project and not closed (unless the issue is already in it).
async function checkRefs(
  req: Request,
  data: { status?: number; sprint?: number | null; assignee?: number | null },
  project: { id: number; workflowId: number },
  current?: { sprintId: number | null },
) {
  const wsId = ws(req).id;
  if (data.status !== undefined) {
    const status = await ref(prisma, "workflowStatus", data.status, wsId, "status");
    if (status.workflowId !== project.workflowId) throw badRequest({ status: "Status does not belong to this project's workflow." });
  }
  if (data.sprint) {
    const sprint = await ref(prisma, "sprint", data.sprint, wsId, "sprint");
    if (sprint.projectId !== project.id) throw badRequest({ sprint: "Sprint belongs to a different project." });
    // Done issues stay in the sprint they closed with, and the issue form resends it on every save.
    if (sprint.state === "closed" && (!current || sprint.id !== current.sprintId)) {
      throw badRequest({ sprint: "This sprint is closed. Pick a planned or active sprint." });
    }
  }
  if (data.assignee) await memberRef(prisma, data.assignee, wsId, "assignee");
}

// Every status change (a drag on the board or the issue form) re-ranks, audits and notifies the same way.
async function move(unit: Unit, req: Request, issueId: number, toStatusId: number, position = {}) {
  const { from, to } = await moveIssue(unit.tx, issueId, toStatusId, position);
  if (from.id !== to.id) {
    const issue = await unit.tx.issue.findUniqueOrThrow({ where: { id: issueId }, include: issueInclude });
    await record(unit, req, "issue.moved", entity.issue(issue, issue.project.key), { status: [from.name, to.name] });
    await notifyIssueEvent(unit, issue, "moved", currentUser(req));
  }
}

export function issuesRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.issue.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: issueInclude }));

  r.get("/", (req, res) => {
    const search = queryString(req, "search");
    const filters = {
      projectId: queryInt(req, "project"),
      statusId: queryInt(req, "status"),
      assigneeId: queryInt(req, "assignee"),
      sprintId: queryInt(req, "sprint"),
      type: queryChoice(req, "type", TYPES),
      priority: queryChoice(req, "priority", PRIORITIES),
    };
    const where = {
      workspaceId: ws(req).id,
      ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)),
      ...(queryString(req, "backlog") === "true" && { sprintId: null }),
      ...(search && {
        OR: [{ title: { contains: search, mode: "insensitive" as const } }, { description: { contains: search, mode: "insensitive" as const } }],
      }),
    };
    const order = ordering(req, ORDERING).map(([f, dir]) => ({ [ORDER_FIELD[f]!]: dir }));
    return sendPage(req, res, prisma.issue, where, [...order, { rank: "asc" }, { id: "asc" }],
      (i: IssueRow) => issueOut(i, req.membership), issueInclude);
  });

  r.get("/:id/", async (req, res) => {
    res.json(issueOut(await find(req), req.membership));
  });

  r.post("/", async (req, res) => {
    need(req, "member");
    const data = parse(issueBody, req.body);
    const project = await ref(prisma, "project", data.project, ws(req).id, "project");
    await checkRefs(req, data, project);
    const user = currentUser(req);
    const created = await inTransaction(async (unit) => {
      // The limit check and the new issue are one step (see enforceLimit).
      await enforceLimit(unit.tx, ws(req).id, "issues");
      const { number, statusId, rank } = await numberAndRank(unit.tx, project.id, data.status);
      const issue = await unit.tx.issue.create({
        data: {
          workspaceId: ws(req).id, projectId: project.id, number, rank, statusId, reporterId: user.id,
          title: data.title, description: data.description, type: data.type, priority: data.priority,
          sprintId: data.sprint ?? null, assigneeId: data.assignee ?? null, storyPoints: data.story_points ?? null,
          dueDate: toDate(data.due_date) ?? null,
        },
        include: issueInclude,
      });
      await record(unit, req, "issue.created", entity.issue(issue, project.key), { title: issue.title });
      if (issue.assigneeId) await notifyIssueEvent(unit, issue, "assigned", user);
      return issue;
    });
    res.status(201).json(issueOut(created, req.membership));
  });

  const update = async (req: Request, res: Response) => {
    need(req, "member");
    const existing = await find(req);
    const data = parse(issuePatch, req.body);
    if (data.project !== undefined && data.project !== existing.projectId) {
      await ref(prisma, "project", data.project, ws(req).id, "project");
      throw badRequest({ project: "Issues cannot be moved between projects." });
    }
    const project = await prisma.project.findUniqueOrThrow({ where: { id: existing.projectId } });
    await checkRefs(req, data, project, existing);
    const user = currentUser(req);
    const updated = await inTransaction(async (unit) => {
      // Lock the row and take its current status, so this save can't undo a move made meanwhile.
      await lockRow(unit.tx, "issues", existing.id);
      const issue = await unit.tx.issue.findUniqueOrThrow({ where: { id: existing.id }, include: { status: true } });
      if (data.status !== undefined && data.status !== issue.statusId) {
        if (!(await canTransition(unit.tx, project.workflowId, issue.statusId, data.status))) {
          const to = await unit.tx.workflowStatus.findUniqueOrThrow({ where: { id: data.status } });
          throw badRequest({ status: `Transition '${issue.status.name}' → '${to.name}' is not allowed.` });
        }
      }
      const fields = {
        title: data.title, description: data.description, type: data.type, priority: data.priority,
        sprint: data.sprint, assignee: data.assignee, story_points: data.story_points, due_date: data.due_date,
      };
      const changes = diff(
        {
          title: issue.title, description: issue.description, type: issue.type, priority: issue.priority, sprint: issue.sprintId,
          assignee: issue.assigneeId, story_points: issue.storyPoints, due_date: day(issue.dueDate),
        },
        fields,
      );
      const saved = await unit.tx.issue.update({
        where: { id: issue.id },
        data: {
          title: data.title, description: data.description, type: data.type, priority: data.priority,
          sprintId: data.sprint, assigneeId: data.assignee, storyPoints: data.story_points, dueDate: toDate(data.due_date),
        },
        include: issueInclude,
      });
      if (Object.keys(changes).length) await record(unit, req, "issue.updated", entity.issue(saved, saved.project.key), changes);
      // A status change from the form lands at the bottom of the new column.
      if (data.status !== undefined && data.status !== issue.statusId) await move(unit, req, issue.id, data.status);
      if (saved.assigneeId && saved.assigneeId !== issue.assigneeId) await notifyIssueEvent(unit, saved, "assigned", user);
      return issue.id;
    });
    res.json(issueOut(await loadIssue(updated), req.membership));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "member");
    const issue = await find(req);
    if (!canDeleteIssue(issue, req.membership)) throw forbidden("Only the reporter or an admin can delete this issue.");
    const files = (await prisma.attachment.findMany({ where: { issueId: issue.id }, select: { file: true } })).map((a) => a.file);
    await inTransaction(async (unit) => {
      await record(unit, req, "issue.deleted", entity.issue(issue, issue.project.key));
      await unit.tx.issue.delete({ where: { id: issue.id } });
    });
    await deleteAttachmentFiles(files);
    res.status(204).end();
  });

  // A member who can't delete an issue asks the workspace's admins and owner to do it.
  r.post("/:id/request_deletion/", async (req, res) => {
    need(req, "member");
    const issue = await find(req);
    if (canDeleteIssue(issue, req.membership)) throw badRequest("You can delete this issue yourself.");
    const user = currentUser(req);
    const pending = await prisma.notification.count({
      where: { workspaceId: ws(req).id, actorId: user.id, issueId: issue.id, verb: "delete_requested", read: false },
    });
    // Don't flood admins with repeat clicks.
    if (pending) return void res.json({ already_requested: true });
    const notes = await inTransaction(async (unit) => {
      const n = await notifyWorkspaceAdmins(unit, issue, "delete_requested", user);
      await record(unit, req, "issue.deletion_requested", entity.issue(issue, issue.project.key), { title: issue.title }, { emitEvent: false });
      return n;
    });
    res.status(202).json({ notified: notes.length });
  });

  // Drag and drop: {"status": <status id>, "after"/"before": <neighbour issue id>, "index": <position>}.
  r.post("/:id/move/", async (req, res) => {
    need(req, "member");
    const issue = await find(req);
    const data = parse(moveBody, req.body);
    if (data.after !== undefined && data.before !== undefined) throw invalid("Send either 'after' or 'before', not both.");
    await ref(prisma, "workflowStatus", data.status, ws(req).id, "status");
    await inTransaction((unit) => move(unit, req, issue.id, data.status, { index: data.index, after: data.after, before: data.before }));
    res.json(issueOut(await loadIssue(issue.id), req.membership));
  });

  // The issue's audit trail (every role can open it, so no IP addresses).
  r.get("/:id/history/", async (req, res) => {
    const issue = await find(req);
    const logs = await prisma.auditLog.findMany({
      where: { workspaceId: ws(req).id, entityType: "issue", entityId: String(issue.id) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
    });
    res.json(logs.map((l) => auditOut(l, false)));
  });
  return r;
}

// ── Comments (members write; the author or an admin may edit or delete) ──────────────────────────────────────
const commentBody = z.object({ issue: id, body: required(100_000) });
const commentPatch = patchOf(commentBody.shape);
const withAuthor = { author: true } as const;

export function commentsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.comment.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: withAuthor }));
  const checkOwner = (req: Request, c: { authorId: number | null }) => {
    if (c.authorId !== currentUser(req).id && !hasRole(req.membership, "admin")) {
      throw forbidden("Only the author or an admin can change this comment.");
    }
  };

  r.get("/", (req, res) => {
    const issueId = queryInt(req, "issue");
    return sendPage(req, res, prisma.comment, { workspaceId: ws(req).id, ...(issueId !== undefined && { issueId }) },
      [{ createdAt: "asc" }, { id: "asc" }], commentOut, withAuthor);
  });
  r.get("/:id/", async (req, res) => {
    res.json(commentOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "member");
    const data = parse(commentBody, req.body);
    await ref(prisma, "issue", data.issue, ws(req).id, "issue");
    const user = currentUser(req);
    const comment = await inTransaction(async (unit) => {
      const c = await unit.tx.comment.create({
        data: { workspaceId: ws(req).id, issueId: data.issue, authorId: user.id, body: data.body },
        include: withAuthor,
      });
      const issue = await unit.tx.issue.findUniqueOrThrow({ where: { id: data.issue }, include: issueInclude });
      await record(unit, req, "comment.created", entity.comment(c), { issue: issueKey(issue) });
      await notifyIssueEvent(unit, issue, "commented", user);
      return c;
    });
    res.status(201).json(commentOut(comment));
  });

  const update = async (req: Request, res: Response) => {
    need(req, "member");
    const c = await find(req);
    const data = parse(commentPatch, req.body);
    if (data.issue !== undefined) await ref(prisma, "issue", data.issue, ws(req).id, "issue");
    fixedOnUpdate(data, { issue: c.issueId });
    checkOwner(req, c);
    const changes = diff({ body: c.body }, { body: data.body });
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.comment.update({ where: { id: c.id }, data: { body: data.body }, include: withAuthor });
      if (Object.keys(changes).length) await record(unit, req, "comment.updated", entity.comment(u), changes);
      return u;
    });
    res.json(commentOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "member");
    const c = await find(req);
    checkOwner(req, c);
    await inTransaction(async (unit) => {
      await record(unit, req, "comment.deleted", entity.comment(c));
      await unit.tx.comment.delete({ where: { id: c.id } });
    });
    res.status(204).end();
  });
  return r;
}
