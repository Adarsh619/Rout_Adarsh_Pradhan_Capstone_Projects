import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { inTransaction, isUniqueViolation, prisma } from "../../lib/db.js";
import { badRequest, invalid } from "../../lib/errors.js";
import { queryInt, routeId } from "../../lib/http.js";
import { id, parse, patchOf, required } from "../../lib/validate.js";
import { entity } from "../audit/entities.js";
import { diff, record } from "../audit/service.js";
import { need, useWorkspace, ws } from "../tenancy/context.js";
import { fixedOnUpdate, own, ref, sendPage } from "./common.js";
import { statusOut, transitionOut, workflowOut } from "./serialize.js";
import { statusOrder } from "./services.js";

// Custom workflows: a set of statuses and the allowed transitions between them. Everyone reads; admins write.

const withRules = { statuses: true, transitions: true } as const;

// ── Workflows ─────────────────────────────────────────────────────────────────────────────────────────────────
const workflowBody = z.object({ name: required(80) });

export function workflowsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.workflow.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id }, include: withRules }));

  r.get("/", (req, res) =>
    sendPage(req, res, prisma.workflow, { workspaceId: ws(req).id }, { id: "asc" }, workflowOut, withRules),
  );
  r.get("/:id/", async (req, res) => {
    res.json(workflowOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(workflowBody, req.body);
    const wf = await inTransaction(async (unit) => {
      const w = await unit.tx.workflow.create({ data: { workspaceId: ws(req).id, name: data.name }, include: withRules });
      await record(unit, req, "workflow.created", entity.workflow(w));
      return w;
    });
    res.status(201).json(workflowOut(wf));
  });

  const update = async (req: Request, res: Response) => {
    need(req, "admin");
    const wf = await find(req);
    const data = parse(patchOf(workflowBody.shape), req.body);
    const changes = diff({ name: wf.name }, data);
    const updated = await inTransaction(async (unit) => {
      const w = await unit.tx.workflow.update({ where: { id: wf.id }, data, include: withRules });
      if (Object.keys(changes).length) await record(unit, req, "workflow.updated", entity.workflow(w), changes);
      return w;
    });
    res.json(workflowOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const wf = await find(req);
    if (wf.isDefault || (await prisma.project.count({ where: { workflowId: wf.id } }))) {
      throw badRequest("Default workflows or workflows used by projects cannot be deleted.");
    }
    await inTransaction(async (unit) => {
      await record(unit, req, "workflow.deleted", entity.workflow(wf));
      await unit.tx.workflow.delete({ where: { id: wf.id } });
    });
    res.status(204).end();
  });
  return r;
}

// ── Statuses ──────────────────────────────────────────────────────────────────────────────────────────────────
const statusBody = z.object({
  workflow: id,
  name: required(50),
  category: z.enum(["todo", "in_progress", "done"]).default("todo"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #2563eb.").default("#64748b"),
  order: z.coerce.number().int().min(0).max(2_147_483_647).default(0),
});
const statusPatch = patchOf({
  workflow: id,
  name: required(50),
  category: z.enum(["todo", "in_progress", "done"]),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a hex colour like #2563eb."),
  order: z.coerce.number().int().min(0).max(2_147_483_647),
});
const UNIQUE_STATUS = "The fields workflow, name must make a unique set.";

export function statusesRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.workflowStatus.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id } }));

  r.get("/", (req, res) => {
    const workflowId = queryInt(req, "workflow");
    return sendPage(req, res, prisma.workflowStatus, { workspaceId: ws(req).id, ...(workflowId !== undefined && { workflowId }) },
      statusOrder, statusOut);
  });
  r.get("/:id/", async (req, res) => {
    res.json(statusOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(statusBody, req.body);
    await ref(prisma, "workflow", data.workflow, ws(req).id, "workflow");
    if (await prisma.workflowStatus.findFirst({ where: { workflowId: data.workflow, name: data.name } })) throw invalid(UNIQUE_STATUS);
    const { workflow, ...fields } = data;
    try {
      const s = await inTransaction(async (unit) => {
        const created = await unit.tx.workflowStatus.create({ data: { workspaceId: ws(req).id, workflowId: workflow, ...fields } });
        await record(unit, req, "status.created", entity.status(created));
        return created;
      });
      res.status(201).json(statusOut(s));
    } catch (err) {
      if (isUniqueViolation(err)) throw invalid(UNIQUE_STATUS);
      throw err;
    }
  });

  const update = async (req: Request, res: Response) => {
    need(req, "admin");
    const s = await find(req);
    const data = parse(statusPatch, req.body);
    if (data.workflow !== undefined) await ref(prisma, "workflow", data.workflow, ws(req).id, "workflow");
    fixedOnUpdate(data, { workflow: s.workflowId });
    if (data.name !== undefined && data.name !== s.name &&
      (await prisma.workflowStatus.findFirst({ where: { workflowId: s.workflowId, name: data.name } }))) {
      throw invalid(UNIQUE_STATUS);
    }
    const fields = { name: data.name, category: data.category, color: data.color, order: data.order };
    const changes = diff({ name: s.name, category: s.category, color: s.color, order: s.order }, fields);
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.workflowStatus.update({ where: { id: s.id }, data: fields });
      if (Object.keys(changes).length) await record(unit, req, "status.updated", entity.status(u), changes);
      return u;
    });
    res.json(statusOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const s = await find(req);
    if (await prisma.issue.count({ where: { statusId: s.id } })) {
      throw badRequest("Move issues out of this status before deleting it.");
    }
    // New issues start in the workflow's first status, so a workflow can't be left with none.
    if (!(await prisma.workflowStatus.count({ where: { workflowId: s.workflowId, id: { not: s.id } } }))) {
      throw badRequest("A workflow needs at least one status.");
    }
    await inTransaction(async (unit) => {
      await record(unit, req, "status.deleted", entity.status(s));
      await unit.tx.workflowStatus.delete({ where: { id: s.id } });
    });
    res.status(204).end();
  });
  return r;
}

// ── Transitions ───────────────────────────────────────────────────────────────────────────────────────────────
const transitionBody = z.object({ workflow: id, from_status: id, to_status: id });
const UNIQUE_TRANSITION = "The fields workflow, from_status, to_status must make a unique set.";

export function transitionsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const find = (req: Request) =>
    own(prisma.workflowTransition.findFirst({
      where: { id: routeId(req), workspaceId: ws(req).id },
      include: { fromStatus: true, toStatus: true },
    }));

  r.get("/", (req, res) => {
    const workflowId = queryInt(req, "workflow");
    return sendPage(req, res, prisma.workflowTransition, { workspaceId: ws(req).id, ...(workflowId !== undefined && { workflowId }) },
      { id: "asc" }, transitionOut);
  });
  r.get("/:id/", async (req, res) => {
    res.json(transitionOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(transitionBody, req.body);
    const wsId = ws(req).id;
    const errors: Record<string, string> = {};
    const [wf, from, to] = await Promise.all([
      prisma.workflow.findFirst({ where: { id: data.workflow, workspaceId: wsId } }),
      prisma.workflowStatus.findFirst({ where: { id: data.from_status, workspaceId: wsId } }),
      prisma.workflowStatus.findFirst({ where: { id: data.to_status, workspaceId: wsId } }),
    ]);
    if (!wf) errors.workflow = `Invalid pk "${data.workflow}" - object does not exist.`;
    if (!from) errors.from_status = `Invalid pk "${data.from_status}" - object does not exist.`;
    if (!to) errors.to_status = `Invalid pk "${data.to_status}" - object does not exist.`;
    if (Object.keys(errors).length) throw badRequest(errors);
    if (from!.workflowId !== wf!.id || to!.workflowId !== wf!.id) throw invalid("Both statuses must belong to the workflow.");
    if (from!.id === to!.id) throw invalid("A transition must connect two different statuses.");
    try {
      const t = await inTransaction(async (unit) => {
        const created = await unit.tx.workflowTransition.create({
          data: { workspaceId: wsId, workflowId: wf!.id, fromStatusId: from!.id, toStatusId: to!.id },
        });
        await record(unit, req, "transition.created", entity.transition(created, from!.name, to!.name));
        return created;
      });
      res.status(201).json(transitionOut(t));
    } catch (err) {
      if (isUniqueViolation(err)) throw invalid(UNIQUE_TRANSITION);
      throw err;
    }
  });

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const t = await find(req);
    await inTransaction(async (unit) => {
      await record(unit, req, "transition.deleted", entity.transition(t, t.fromStatus.name, t.toStatus.name));
      await unit.tx.workflowTransition.delete({ where: { id: t.id } });
    });
    res.status(204).end();
  });
  return r;
}
