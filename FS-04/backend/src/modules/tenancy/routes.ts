import { Router, type Request } from "express";
import { z } from "zod";
import type { Membership, Role, User, Workspace } from "../../generated/prisma/client.js";
import { inTransaction, prisma } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";
import { iso, pageOf, paginated, routeId } from "../../lib/http.js";
import { id, parse, patchOf, required } from "../../lib/validate.js";
import { entity } from "../audit/entities.js";
import { diff, record } from "../audit/service.js";
import { currentUser } from "../auth/middleware.js";
import { userOut } from "../auth/serialize.js";
import { enforceLimit } from "../billing/limits.js";
import { hasRole, need, useWorkspace, ws } from "./context.js";
import { createWorkspace, deleteWorkspace, removeMember, transferOwnership } from "./services.js";

// ── Workspaces: the caller's own list (not tenant-scoped: it is the tenant list) ───────────────────────────────

const workspaceOut = (w: Workspace & { subscription?: { plan: string } | null }, role: Role | null) => ({
  id: w.id,
  name: w.name,
  slug: w.slug,
  created_at: iso(w.createdAt),
  role,
  plan: w.subscription?.plan ?? "free",
});

const workspaceBody = z.object({ name: required(100) });

async function mine(req: Request, slug: string) {
  const m = await prisma.membership.findFirst({
    where: { userId: currentUser(req).id, workspace: { slug } },
    include: { workspace: { include: { subscription: true } } },
  });
  if (!m) throw notFound();
  return m;
}

function requireWorkspaceRole(m: { role: Role }, role: Role) {
  if (!hasRole(m, role)) throw forbidden("Insufficient role.");
}

export function workspacesRouter(): Router {
  const r = Router();

  r.get("/", async (req, res) => {
    const userId = currentUser(req).id;
    const page = pageOf(req);
    const where = { userId };
    const [count, rows] = await Promise.all([
      prisma.membership.count({ where }),
      prisma.membership.findMany({
        where,
        include: { workspace: { include: { subscription: true } } },
        orderBy: { workspaceId: "asc" },
        skip: page.offset,
        take: page.limit,
      }),
    ]);
    res.json(paginated(req, page, count, rows.map((m) => workspaceOut(m.workspace, m.role))));
  });

  r.post("/", async (req, res) => {
    const { name } = parse(workspaceBody, req.body);
    const w = await createWorkspace(name, currentUser(req));
    const sub = await prisma.subscription.findUnique({ where: { workspaceId: w.id } });
    res.status(201).json(workspaceOut({ ...w, subscription: sub }, "owner"));
  });

  r.get("/:slug/", async (req, res) => {
    const m = await mine(req, req.params.slug!);
    res.json(workspaceOut(m.workspace, m.role));
  });

  r.patch("/:slug/", async (req, res) => {
    const m = await mine(req, req.params.slug!);
    const data = parse(patchOf(workspaceBody.shape), req.body);
    requireWorkspaceRole(m, "admin");
    const changes = diff({ name: m.workspace.name }, data);
    const updated = await inTransaction(async (unit) => {
      const w = await unit.tx.workspace.update({ where: { id: m.workspaceId }, data, include: { subscription: true } });
      if (Object.keys(changes).length) {
        await record(unit, req, "workspace.updated", entity.workspace(w), changes, { emitEvent: false, workspaceId: w.id });
      }
      return w;
    });
    res.json(workspaceOut(updated, m.role));
  });

  r.delete("/:slug/", async (req, res) => {
    const m = await mine(req, req.params.slug!);
    requireWorkspaceRole(m, "owner");
    await deleteWorkspace(m.workspaceId);
    res.status(204).end();
  });

  // Owner only: another member (`user_id`) becomes the owner; you become an admin.
  r.post("/:slug/transfer/", async (req, res) => {
    const m = await mine(req, req.params.slug!);
    requireWorkspaceRole(m, "owner");
    const userId = req.body?.user_id;
    const target = /^\d+$/.test(String(userId ?? ""))
      ? await prisma.membership.findFirst({ where: { workspaceId: m.workspaceId, userId: Number(userId) }, include: { user: true } })
      : null;
    if (!target) throw badRequest({ user_id: "Choose a member of this workspace." });
    const me = currentUser(req);
    if (target.userId === me.id) throw badRequest({ user_id: "You already own this workspace." });
    await inTransaction(async (unit) => {
      await transferOwnership(unit.tx, m.workspaceId, target);
      await record(unit, req, "workspace.ownership_transferred", entity.workspace(m.workspace),
        { owner: [me.email, target.user.email] }, { emitEvent: false, workspaceId: m.workspaceId });
    });
    const after = await mine(req, req.params.slug!);
    res.json(workspaceOut(after.workspace, after.role));
  });

  return r;
}

// ── Members of the current workspace ──────────────────────────────────────────────────────────────────────────

const memberOut = (m: Membership & { user: User }) => ({
  id: m.id,
  user: userOut(m.user),
  role: m.role,
  joined_at: iso(m.joinedAt),
});

const assignableRole = z.enum(["owner", "admin", "member", "viewer"]).refine((r) => r !== "owner", {
  message: "Ownership cannot be assigned through this endpoint.",
});
const addBody = z.object({ email: z.email().optional(), role: assignableRole.default("member") });
const roleBody = z.object({ role: assignableRole.optional(), email: z.unknown().optional() });

// Admins manage members and viewers; only the owner can grant, change or remove the admin role.
function ownerOnlyForAdmins(req: Request, ...roles: Role[]) {
  if (roles.includes("admin") && req.membership!.role !== "owner") {
    throw forbidden("Only the workspace owner can add, change or remove admins.");
  }
}

async function memberById(req: Request) {
  const m = await prisma.membership.findFirst({
    where: { id: routeId(req), workspaceId: ws(req).id },
    include: { user: true },
  });
  if (!m) throw notFound();
  return m;
}

export function membersRouter(): Router {
  const r = Router();
  r.use(useWorkspace);

  r.get("/", async (req, res) => {
    const page = pageOf(req);
    const where = { workspaceId: ws(req).id };
    const [count, rows] = await Promise.all([
      prisma.membership.count({ where }),
      prisma.membership.findMany({
        where,
        include: { user: true },
        orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
        skip: page.offset,
        take: page.limit,
      }),
    ]);
    res.json(paginated(req, page, count, rows.map(memberOut)));
  });

  r.get("/:id/", async (req, res) => {
    res.json(memberOut(await memberById(req)));
  });

  r.post("/", async (req, res) => {
    need(req, "admin");
    const data = parse(addBody, req.body);
    if (!data.email) throw badRequest({ email: "Email is required." });
    const user = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    if (!user) throw badRequest({ email: "No user with this email. Ask them to sign up first." });
    if (await prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: ws(req).id, userId: user.id } } })) {
      throw badRequest({ email: "User is already a member." });
    }
    ownerOnlyForAdmins(req, data.role);
    const m = await inTransaction(async (unit) => {
      await enforceLimit(unit.tx, ws(req).id, "members");
      const created = await unit.tx.membership.create({
        data: { workspaceId: ws(req).id, userId: user.id, role: data.role },
        include: { user: true },
      });
      await record(unit, req, "member.added", entity.membership(created, user.email, ws(req).name), {
        email: user.email,
        role: created.role,
      });
      return created;
    });
    res.status(201).json(memberOut(m));
  });

  const update = async (req: Request, res: import("express").Response) => {
    need(req, "admin");
    const m = await memberById(req);
    const data = parse(roleBody, req.body);
    if (m.role === "owner") throw badRequest({ non_field_errors: "The owner's role cannot be changed." });
    const role = data.role ?? m.role;
    ownerOnlyForAdmins(req, m.role, role);
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.membership.update({ where: { id: m.id }, data: { role }, include: { user: true } });
      await record(unit, req, "member.role_changed", entity.membership(u, u.user.email, ws(req).name), {
        role: [m.role, u.role],
      });
      return u;
    });
    res.json(memberOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    need(req, "admin");
    const m = await memberById(req);
    if (m.role === "owner") throw forbidden("The owner cannot be removed.");
    ownerOnlyForAdmins(req, m.role);
    await inTransaction((unit) => removeMember(unit, req, m, "member.removed"));
    res.status(204).end();
  });

  // Remove yourself from this workspace. The owner must transfer ownership first.
  r.post("/leave/", async (req, res) => {
    const m = await prisma.membership.findUniqueOrThrow({ where: { id: req.membership!.id }, include: { user: true } });
    if (m.role === "owner") throw badRequest("Transfer ownership to another member before leaving.");
    await inTransaction((unit) => removeMember(unit, req, m, "member.left"));
    res.status(204).end();
  });

  return r;
}

export { id };
