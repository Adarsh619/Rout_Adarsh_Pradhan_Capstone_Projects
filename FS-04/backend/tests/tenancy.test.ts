import { describe, expect, it } from "vitest";
import { addMember, clientFor, createWorkspace, makeUser, newIssue, newProject, prisma, statusesOf, world } from "./helpers.js";

// Workspaces and members (v1: test_tenancy).

const markDone = async (issueId: number, workspaceId: number) => {
  const done = await prisma.workflowStatus.findFirstOrThrow({ where: { workspaceId, category: "done" } });
  await prisma.issue.update({ where: { id: issueId }, data: { statusId: done.id } });
};

describe("removed members", () => {
  it("removing a member unassigns their open issues and stops their notifications", async () => {
    const { api, workspace } = await world();
    const project = await newProject(api);
    const m = await addMember(workspace, "leaver@acme.test", "member");
    const open = await newIssue(api, project, { assignee: m.id });
    const done = await newIssue(api, project, { assignee: m.id });
    await markDone(done.id, workspace.id);
    const reported = await newIssue(await clientFor(m, workspace), project);

    const membership = await prisma.membership.findFirstOrThrow({ where: { workspaceId: workspace.id, userId: m.id } });
    expect((await api.delete(`/api/members/${membership.id}/`)).status).toBe(204);

    expect((await prisma.issue.findUniqueOrThrow({ where: { id: open.id } })).assigneeId).toBeNull();
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: done.id } })).assigneeId).toBe(m.id); // history kept
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "member.removed" } });
    expect(entry.changes).toEqual({ email: "leaver@acme.test", unassigned_issues: [open.key] });
    expect(entry.entityId).toBe(String(membership.id));

    // Still the reporter of an issue, but hears nothing about new comments on it.
    await prisma.notification.deleteMany();
    await api.post("/api/comments/", { issue: reported.id, body: "Still open?" });
    await api.post("/api/comments/", { issue: done.id, body: "Reopening" });
    expect(await prisma.notification.count({ where: { userId: m.id } })).toBe(0);
  });
});

describe("admin role", () => {
  it("only the owner can grant, change or remove the admin role", async () => {
    const { api, workspace } = await world();
    const a1 = await addMember(workspace, "a1@acme.test", "admin");
    const a2 = await addMember(workspace, "a2@acme.test", "admin");
    const mm = await addMember(workspace, "mm@acme.test", "member");
    await makeUser("new1@acme.test");
    await makeUser("new2@acme.test");
    const a2m = await prisma.membership.findFirstOrThrow({ where: { userId: a2.id } });
    const mmm = await prisma.membership.findFirstOrThrow({ where: { userId: mm.id } });
    const admin = await clientFor(a1, workspace);

    expect((await admin.patch(`/api/members/${a2m.id}/`, { role: "member" })).status).toBe(403);
    expect((await admin.delete(`/api/members/${a2m.id}/`)).status).toBe(403);
    expect((await admin.patch(`/api/members/${mmm.id}/`, { role: "admin" })).status).toBe(403);
    expect((await admin.post("/api/members/", { email: "new1@acme.test", role: "admin" })).status).toBe(403);
    // Admins still manage members and viewers.
    expect((await admin.patch(`/api/members/${mmm.id}/`, { role: "viewer" })).status).toBe(200);
    expect((await admin.post("/api/members/", { email: "new1@acme.test", role: "viewer" })).status).toBe(201);

    expect((await api.patch(`/api/members/${a2m.id}/`, { role: "member" })).status).toBe(200);
    const a1m = await prisma.membership.findFirstOrThrow({ where: { userId: a1.id } });
    expect((await api.delete(`/api/members/${a1m.id}/`)).status).toBe(204); // frees a seat on the Free plan
    expect((await api.post("/api/members/", { email: "new2@acme.test", role: "admin" })).status).toBe(201);
  });

  it("refuses to make anyone owner through the members endpoint", async () => {
    const { api, workspace } = await world();
    const m = await addMember(workspace, "m@acme.test", "member");
    const mm = await prisma.membership.findFirstOrThrow({ where: { userId: m.id } });
    const r = await api.patch(`/api/members/${mm.id}/`, { role: "owner" });
    expect(r.status).toBe(400);
    expect(r.body.role[0]).toContain("Ownership cannot be assigned");
  });
});

describe("tenant resolution and leaving", () => {
  it("ignores a workspace query parameter: the tenant comes from the header only", async () => {
    const { owner, workspace } = await world();
    const r = await (await clientFor(owner)).get(`/api/projects/?workspace=${workspace.slug}`);
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("X-Workspace");
  });

  it("a member can leave; their issues are unassigned", async () => {
    const { api, workspace } = await world();
    const project = await newProject(api);
    const m = await addMember(workspace, "quitter@acme.test", "viewer");
    const issue = await newIssue(api, project, { assignee: m.id });
    const c = await clientFor(m, workspace);
    expect((await c.post("/api/members/leave/")).status).toBe(204);
    expect(await prisma.membership.count({ where: { workspaceId: workspace.id, userId: m.id } })).toBe(0);
    expect((await prisma.issue.findUniqueOrThrow({ where: { id: issue.id } })).assigneeId).toBeNull();
    const left = await prisma.auditLog.findFirstOrThrow({ where: { action: "member.left" } });
    expect((left.changes as { email: string }).email).toBe("quitter@acme.test");
    expect((await c.get("/api/projects/")).status).toBe(404);
  });

  it("the owner cannot leave", async () => {
    const { api } = await world();
    const r = await api.post("/api/members/leave/");
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("Transfer ownership");
  });
});

describe("ownership", () => {
  it("the owner transfers ownership", async () => {
    const { api, owner, workspace } = await world();
    const heir = await addMember(workspace, "heir@acme.test", "member");
    const admin = await addMember(workspace, "adm@acme.test", "admin");
    const outsider = await makeUser("out@globex.test");
    const url = `/api/workspaces/${workspace.slug}/transfer/`;

    expect((await (await clientFor(admin)).post(url, { user_id: heir.id })).status).toBe(403);
    expect((await api.post(url, { user_id: outsider.id })).status).toBe(400);
    expect((await api.post(url, { user_id: owner.id })).status).toBe(400);
    expect((await api.post(url, { user_id: "abc" })).status).toBe(400);

    const r = await api.post(url, { user_id: heir.id });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("admin");
    expect((await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } })).ownerId).toBe(heir.id);
    const roles = Object.fromEntries(
      (await prisma.membership.findMany({ where: { workspaceId: workspace.id }, include: { user: true } })).map((m) => [m.user.email, m.role]),
    );
    expect(roles["heir@acme.test"]).toBe("owner");
    expect(roles["owner@acme.test"]).toBe("admin");
    expect(await prisma.membership.count({ where: { workspaceId: workspace.id, role: "owner" } })).toBe(1);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "workspace.ownership_transferred" } });
    expect(entry.changes).toEqual({ owner: ["owner@acme.test", "heir@acme.test"] });

    // The new owner has the owner's powers; the old owner no longer does.
    expect((await (await clientFor(owner)).delete(`/api/workspaces/${workspace.slug}/`)).status).toBe(403);
    expect((await (await clientFor(owner, workspace)).post("/api/members/leave/")).status).toBe(204);
    expect((await (await clientFor(heir)).delete(`/api/workspaces/${workspace.slug}/`)).status).toBe(204);
  });
});

describe("workspaces", () => {
  it("two workspaces with the same name created at once get different slugs", async () => {
    const [a, b] = [await makeUser("a@x.test"), await makeUser("b@x.test")];
    const made = await Promise.all([createWorkspace("Acme", a), createWorkspace("Acme", b), createWorkspace("Acme", a)]);
    expect(new Set(made.map((w) => w.slug)).size).toBe(3);
    for (const w of made) expect(await prisma.membership.count({ where: { workspaceId: w.id, role: "owner" } })).toBe(1);
  });

  it("slugs follow the v1 rules", async () => {
    const u = await makeUser("u@x.test");
    expect((await createWorkspace("Café Ünïcode & Co!", u)).slug).toBe("cafe-unicode-co");
    expect((await createWorkspace("!!!", u)).slug).toBe("workspace");
  });

  it("renaming is audited and admin-only", async () => {
    const { api, workspace } = await world();
    const m = await addMember(workspace, "m@acme.test", "member");
    const url = `/api/workspaces/${workspace.slug}/`;
    expect((await (await clientFor(m)).patch(url, { name: "Hijacked" })).status).toBe(403);
    expect((await api.patch(url, { name: "Acme Corp" })).status).toBe(200);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "workspace.updated" } });
    expect(entry.workspaceId).toBe(workspace.id);
    expect(entry.changes).toEqual({ name: ["Acme", "Acme Corp"] });
  });

  it("the list shows your role in each workspace", async () => {
    const owner = await makeUser("owner@acme.test");
    await createWorkspace("One", owner);
    for (const [i, role] of (["admin", "viewer"] as const).entries()) {
      const other = await createWorkspace(`Other ${i}`, await makeUser(`boss${i}@x.test`));
      await prisma.membership.create({ data: { workspaceId: other.id, userId: owner.id, role } });
      for (let j = 0; j < 3; j++) await addMember(other, `u${i}${j}@x.test`, "member");
    }
    const r = await (await clientFor(owner)).get("/api/workspaces/");
    expect(Object.fromEntries(r.body.results.map((w: { slug: string; role: string }) => [w.slug, w.role]))).toEqual({
      one: "owner", "other-0": "admin", "other-1": "viewer",
    });
  });

  it("creating a workspace makes you owner with a default workflow and the free plan", async () => {
    const u = await makeUser("u@x.test");
    const r = await (await clientFor(u)).post("/api/workspaces/", { name: "Fresh" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ slug: "fresh", role: "owner", plan: "free" });
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { slug: "fresh" } });
    expect((await statusesOf(ws)).map((s) => s.name)).toEqual(["To Do", "In Progress", "In Review", "Done"]);
  });
});
