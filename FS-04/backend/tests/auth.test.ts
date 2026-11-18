import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { addMember, anon, clientFor, createWorkspace, makeUser, newIssue, newProject, prisma, STRONG, world } from "./helpers.js";

// Accounts, login tokens, and the basics of tenant isolation and roles (v1: test_accounts, test_auth_and_tenancy).

const login = async (email: string, password: string) => (await anon()).post("/api/auth/token/", { email, password });

describe("accounts", () => {
  it("login ignores email case", async () => {
    await makeUser("owner@acme.test");
    const r = await login("Owner@ACME.test", "pass12345");
    expect(r.status).toBe(200);
    expect(r.body.access).toBeTruthy();
  });

  it("rejects a wrong password", async () => {
    await makeUser("owner@acme.test");
    expect((await login("owner@acme.test", "wrong-password")).status).toBe(401);
  });

  it.each([
    ["short1", "too short"],
    ["password123", "too common"],
    ["4815162342", "entirely numeric"],
    ["jane.doe.co", "too similar"],
  ])("register rejects the weak password %s", async (password, message) => {
    const r = await (await anon()).post("/api/auth/register/", { email: "jane.doe@co.test", password });
    expect(r.status).toBe(400);
    expect(r.body.password.join(" ")).toContain(message);
    expect(await prisma.user.count({ where: { email: "jane.doe@co.test" } })).toBe(0);
  });

  it("register rejects a duplicate email in any case", async () => {
    await makeUser("owner@acme.test");
    const r = await (await anon()).post("/api/auth/register/", { email: "OWNER@acme.test", password: STRONG });
    expect(r.status).toBe(400);
    expect(r.body.email).toBeTruthy();
  });

  it("me returns and updates the profile; email is read-only", async () => {
    const owner = await makeUser("owner@acme.test");
    const c = await clientFor(owner);
    expect((await c.get("/api/auth/me/")).body.email).toBe("owner@acme.test");
    const r = await c.patch("/api/auth/me/", { full_name: "Olivia Owner", email: "hijack@evil.test" });
    expect(r.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(after.fullName).toBe("Olivia Owner");
    expect(after.email).toBe("owner@acme.test");
  });

  it("refresh rotates, and the old refresh token stops working", async () => {
    await makeUser("owner@acme.test");
    const c = await anon();
    const first = (await login("owner@acme.test", "pass12345")).body.refresh;
    const r = await c.post("/api/auth/token/refresh/", { refresh: first });
    expect(r.status).toBe(200);
    expect(r.body.refresh).not.toBe(first);
    expect((await c.post("/api/auth/token/refresh/", { refresh: first })).status).toBe(401);
  });

  it("logout blacklists the refresh token", async () => {
    await makeUser("owner@acme.test");
    const c = await anon();
    const refresh = (await login("owner@acme.test", "pass12345")).body.refresh;
    expect((await c.post("/api/auth/logout/", { refresh })).status).toBe(200);
    expect((await c.post("/api/auth/token/refresh/", { refresh })).status).toBe(401);
  });

  it("changes the password and signs out older sessions", async () => {
    const owner = await makeUser("owner@acme.test");
    const oldRefresh = (await login(owner.email, "pass12345")).body.refresh;
    const c = await clientFor(owner);
    let r = await c.post("/api/auth/password/", { current_password: "nope", new_password: STRONG });
    expect(r.status).toBe(400);
    expect(r.body.current_password).toBeTruthy();
    r = await c.post("/api/auth/password/", { current_password: "pass12345", new_password: "12345678" });
    expect(r.status).toBe(400);
    expect(r.body.new_password).toBeTruthy();

    r = await c.post("/api/auth/password/", { current_password: "pass12345", new_password: STRONG });
    expect(r.status).toBe(200);
    expect(r.body.access && r.body.refresh).toBeTruthy();
    expect((await login(owner.email, "pass12345")).status).toBe(401);
    expect((await login(owner.email, STRONG)).status).toBe(200);
    const fresh = await anon();
    expect((await fresh.post("/api/auth/token/refresh/", { refresh: oldRefresh })).status).toBe(401);
    expect((await fresh.post("/api/auth/token/refresh/", { refresh: r.body.refresh })).status).toBe(200);
  });

  it("password change requires login", async () => {
    const r = await (await anon()).post("/api/auth/password/", { current_password: "x", new_password: STRONG });
    expect(r.status).toBe(401);
  });

  it("rate-limits login attempts", async () => {
    await makeUser("owner@acme.test");
    config.AUTH_RATE_LIMIT = "3/minute";
    const c = await anon();
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await c.post("/api/auth/token/", { email: "owner@acme.test", password: "wrong" })).status);
    expect(codes).toEqual([401, 401, 401, 429]);
  });

  it("rejects a tampered or wrong-type token", async () => {
    const owner = await makeUser("owner@acme.test");
    const pair = (await login(owner.email, "pass12345")).body;
    const r = await (await anon()).get("/api/auth/me/").set("Authorization", `Bearer ${pair.refresh}`);
    expect(r.status).toBe(401);
    const bad = await (await anon()).get("/api/auth/me/").set("Authorization", `Bearer ${pair.access}x`);
    expect(bad.status).toBe(401);
  });
});

describe("auth and tenancy", () => {
  it("register creates the user, a workspace and tokens", async () => {
    const c = await anon();
    const r = await c.post("/api/auth/register/", { email: "New@Co.test", password: "longpassword", workspace_name: "New Co" });
    expect(r.status).toBe(201);
    expect(r.body.workspace).toBe("new-co");
    expect(r.body.access).toBeTruthy();
    const l = await c.post("/api/auth/token/", { email: "new@co.test", password: "longpassword" });
    expect(l.status).toBe(200);
  });

  it("register rejects a duplicate email", async () => {
    await makeUser("owner@acme.test");
    expect((await (await anon()).post("/api/auth/register/", { email: "owner@acme.test", password: "longpassword" })).status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    expect((await (await anon()).get("/api/projects/")).status).toBe(401);
  });

  it("requires the X-Workspace header", async () => {
    const owner = await makeUser("owner@acme.test");
    expect((await (await clientFor(owner)).get("/api/projects/")).status).toBe(400);
  });

  it("lists only the caller's workspaces", async () => {
    const { owner } = await world();
    await createWorkspace("Globex", await makeUser("x@globex.test"));
    const r = await (await clientFor(owner)).get("/api/workspaces/");
    expect(r.body.results.map((w: { slug: string }) => w.slug)).toEqual(["acme"]);
    expect(r.body.results[0].role).toBe("owner");
  });

  it("isolates tenants, even when ids are guessed", async () => {
    const { api } = await world();
    const project = await newProject(api);
    await newIssue(api, project, { title: "Secret Acme issue" });
    const outsider = await makeUser("spy@globex.test");
    const globex = await createWorkspace("Globex", outsider);
    const spy = await clientFor(outsider, globex);
    expect((await spy.get("/api/issues/")).body.results).toEqual([]);
    expect((await spy.get(`/api/projects/${project.id}/`)).status).toBe(404);
    expect((await spy.post("/api/issues/", { project: project.id, title: "x" })).status).toBe(400);
    expect((await spy.workspace("acme").get("/api/issues/")).status).toBe(404);
  });

  it("cannot assign a non-member", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const stranger = await makeUser("stranger@x.test");
    const r = await api.post("/api/issues/", { project: project.id, title: "t", assignee: stranger.id });
    expect(r.status).toBe(400);
    expect(r.body.assignee).toBeTruthy();
  });

  it.each([
    ["viewer", false, false, false],
    ["member", true, false, false],
    ["admin", true, true, true],
  ] as const)("role %s permissions", async (role, canCreateIssue, canCreateProject, canViewAudit) => {
    const { api, workspace } = await world();
    const project = await newProject(api);
    const c = await clientFor(await addMember(workspace, `${role}@acme.test`, role), workspace);
    expect((await c.get("/api/issues/")).status).toBe(200);
    expect((await c.post("/api/issues/", { project: project.id, title: `From ${role}` })).status === 201).toBe(canCreateIssue);
    expect((await c.post("/api/projects/", { key: `N${role.slice(0, 3).toUpperCase()}`, name: "New" })).status === 201).toBe(canCreateProject);
    expect((await c.get("/api/audit-logs/")).status === 200).toBe(canViewAudit);
  });

  it("manages members", async () => {
    const { api, workspace } = await world();
    await makeUser("invitee@acme.test");
    let r = await api.post("/api/members/", { email: "invitee@acme.test", role: "member" });
    expect(r.status).toBe(201);
    r = await api.patch(`/api/members/${r.body.id}/`, { role: "admin" });
    expect(r.body.role).toBe("admin");
    const ownerM = await prisma.membership.findFirstOrThrow({ where: { workspaceId: workspace.id, role: "owner" } });
    expect((await api.delete(`/api/members/${ownerM.id}/`)).status).toBe(403);
    const m = await addMember(workspace, "m@acme.test", "member");
    expect((await (await clientFor(m, workspace)).post("/api/members/", { email: "x@y.z" })).status).toBe(403);
  });

  it("only the owner can delete a workspace, data included", async () => {
    const { api, workspace } = await world();
    await newIssue(api, await newProject(api), { title: "x" });
    const admin = await addMember(workspace, "adm@acme.test", "admin");
    expect((await (await clientFor(admin)).delete(`/api/workspaces/${workspace.slug}/`)).status).toBe(403);
    expect((await api.delete(`/api/workspaces/${workspace.slug}/`)).status).toBe(204);
    expect(await prisma.workspace.count({ where: { id: workspace.id } })).toBe(0);
  });
});
