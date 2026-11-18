import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { outbox } from "../src/lib/mail.js";
import { deleteWorkspace } from "../src/modules/tenancy/services.js";
import { absolute } from "../src/modules/tracker/files.js";
import { addMember, clientFor, createWorkspace, makeUser, newIssue, newProject, newSprint, prisma, world, type Client } from "./helpers.js";

// Data rules the database itself enforces, input checks, attachment files and issue deletion
// (v1: test_tracker_models, test_issue_deletion).

describe("database rules", () => {
  it("allows only one active sprint per project", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const [s1, s2] = [await newSprint(api, project), await newSprint(api, project)];
    expect((await api.post(`/api/sprints/${s1.id}/start/`)).status).toBe(200);
    await expect(prisma.sprint.update({ where: { id: s2.id }, data: { state: "active" } })).rejects.toThrow();
  });

  it("allows only one default workflow per workspace", async () => {
    const { workspace } = await world();
    expect(await prisma.workflow.count({ where: { workspaceId: workspace.id, isDefault: true } })).toBe(1);
    await expect(prisma.workflow.create({ data: { workspaceId: workspace.id, name: "Another", isDefault: true } })).rejects.toThrow();
    await prisma.workflow.create({ data: { workspaceId: workspace.id, name: "Custom" } });
  });

  it("checks sprint dates on a partial update and in the database", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const s = await newSprint(api, project, { start_date: "2026-11-10", end_date: "2026-11-20" });
    let r = await api.patch(`/api/sprints/${s.id}/`, { end_date: "2026-11-01" });
    expect(r.status).toBe(400);
    expect(r.body.end_date).toBeTruthy();
    r = await api.patch(`/api/sprints/${s.id}/`, { start_date: "2026-11-25" });
    expect(r.status).toBe(400);
    expect((await api.patch(`/api/sprints/${s.id}/`, { end_date: "2026-11-10" })).status).toBe(200);
    await expect(prisma.sprint.update({ where: { id: s.id }, data: { endDate: new Date("2026-11-01") } })).rejects.toThrow();
  });
});

describe("input checks", () => {
  it.each([
    ["#12ab9F", true], ["url(x)", false], ["red", false], ["#12ab9", false], ["#12ab9g", false],
  ])("status colour %s accepted: %s", async (color, ok) => {
    const { api, workspace } = await world();
    const wf = await prisma.workflow.findFirstOrThrow({ where: { workspaceId: workspace.id, isDefault: true } });
    const r = await api.post("/api/statuses/", { workflow: wf.id, name: `S ${color}`, color });
    expect(r.status, JSON.stringify(r.body)).toBe(ok ? 201 : 400);
    if (!ok) expect(r.body.color).toBeTruthy();
  });

  it.each([["web2", "WEB2"], ["CAFÉ", null], ["A²", null], ["A-B", null]])("project key %s saves as %s", async (key, saved) => {
    const { api } = await world();
    const r = await api.post("/api/projects/", { key, name: "P" });
    if (saved) {
      expect(r.status).toBe(201);
      expect(r.body.key).toBe(saved);
    } else {
      expect(r.status).toBe(400);
      expect(r.body.key).toBeTruthy();
    }
  });

  it("links to another workspace's rows are refused", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const globex = await createWorkspace("Globex", await makeUser("owner@globex.test"));
    const foreignStatus = await prisma.workflowStatus.findFirstOrThrow({ where: { workspaceId: globex.id } });
    const foreignWf = await prisma.workflow.findFirstOrThrow({ where: { workspaceId: globex.id } });
    const outsider = await makeUser("out@globex.test");
    let r = await api.post("/api/issues/", { project: project.id, title: "x", status: foreignStatus.id });
    expect(r.status).toBe(400);
    expect(r.body.status).toBeTruthy();
    r = await api.post("/api/issues/", { project: project.id, title: "x", assignee: outsider.id });
    expect(r.body.assignee).toBeTruthy();
    r = await api.post("/api/projects/", { key: "X", name: "X", workflow: foreignWf.id });
    expect(r.status).toBe(400);
    expect(r.body.workflow).toBeTruthy();
  });

  it("every tenant resource answers 404 to another workspace", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const issue = await newIssue(api, project);
    const sprint = await newSprint(api, project);
    const comment = (await api.post("/api/comments/", { issue: issue.id, body: "x" })).body;
    const hook = (await api.post("/api/webhooks/", { url: "https://example.com/hook" })).body;
    const ws = await prisma.workflow.findFirstOrThrow();
    const status = await prisma.workflowStatus.findFirstOrThrow();
    const transition = await prisma.workflowTransition.findFirstOrThrow();
    const member = await prisma.membership.findFirstOrThrow();
    const audit = await prisma.auditLog.findFirstOrThrow();
    const outsider = await makeUser("spy@globex.test");
    const spy = await clientFor(outsider, await createWorkspace("Globex", outsider));
    const urls = [
      `/api/projects/${project.id}/`, `/api/boards/${project.board_id}/`, `/api/boards/${project.board_id}/columns/`,
      `/api/sprints/${sprint.id}/`, `/api/issues/${issue.id}/`, `/api/issues/${issue.id}/history/`,
      `/api/comments/${comment.id}/`, `/api/workflows/${ws.id}/`, `/api/statuses/${status.id}/`,
      `/api/transitions/${transition.id}/`, `/api/members/${member.id}/`, `/api/webhooks/${hook.id}/`,
      `/api/audit-logs/${audit.id}/`,
    ];
    for (const url of urls) expect((await spy.get(url)).status, url).toBe(404);
    expect((await spy.delete(`/api/issues/${issue.id}/`)).status).toBe(404);
    expect((await spy.patch(`/api/projects/${project.id}/`, { name: "Owned" })).status).toBe(404);
  });
});

describe("attachment files", () => {
  async function upload(api: Client, project: { id: number }, name = "notes.txt") {
    const issue = await newIssue(api, project, { title: "Has files" });
    const r = await api.post("/api/attachments/").field("issue", String(issue.id)).attach("file", Buffer.from("hello"), name);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const att = await prisma.attachment.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(existsSync(absolute(att.file))).toBe(true);
    return att;
  }

  it("deleting an issue or a workspace removes their files", async () => {
    const { api, workspace } = await world();
    const project = await newProject(api);
    const [a1, a2] = [await upload(api, project, "a.txt"), await upload(api, project, "b.txt")];
    expect((await api.delete(`/api/issues/${a1.issueId}/`)).status).toBe(204);
    expect(existsSync(absolute(a1.file))).toBe(false);
    expect(existsSync(absolute(a2.file))).toBe(true);
    await deleteWorkspace(workspace.id);
    expect(existsSync(absolute(a2.file))).toBe(false);
  });

  it("two files with the same name are both kept", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const issue = await newIssue(api, project);
    const send = () => api.post("/api/attachments/").field("issue", String(issue.id)).attach("file", Buffer.from("x"), "same.txt");
    const [a, b] = [(await send()).body, (await send()).body];
    const files = await prisma.attachment.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(new Set(files.map((f) => f.file)).size).toBe(2);
    expect(files.map((f) => f.filename)).toEqual(["same.txt", "same.txt"]);
  });

  it("a hostile file name can't leave the upload folder", async () => {
    const { api } = await world();
    const project = await newProject(api);
    const att = await upload(api, project, "../../evil.txt");
    expect(att.file).toMatch(/^workspaces\/1\/issues\/\d+\/evil\.txt$/);
  });
});

describe("issue deletion", () => {
  async function people() {
    const w = await world();
    const project = await newProject(w.api);
    const users = {
      reporter: await addMember(w.workspace, "reporter@acme.test", "member"),
      member: await addMember(w.workspace, "other@acme.test", "member"),
      admin: await addMember(w.workspace, "admin@acme.test", "admin"),
      viewer: await addMember(w.workspace, "viewer@acme.test", "viewer"),
    };
    const clients = Object.fromEntries(
      await Promise.all(Object.entries(users).map(async ([k, u]) => [k, await clientFor(u, w.workspace)] as const)),
    ) as Record<keyof typeof users, Client>;
    const issue = await newIssue(clients.reporter, project, { title: "Fix login" });
    return { ...w, project, users, clients, issue };
  }

  it.each([["member", false], ["viewer", false], ["reporter", true]] as const)("%s may delete: %s", async (who, allowed) => {
    const { clients, issue } = await people();
    const r = await clients[who].delete(`/api/issues/${issue.id}/`);
    expect(r.status).toBe(allowed ? 204 : 403);
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(allowed ? 0 : 1);
    if (who === "member") expect(JSON.stringify(r.body)).toContain("reporter or an admin");
  });

  it.each(["admin", "owner"] as const)("the %s can delete anyone's issue", async (who) => {
    const { clients, api, issue } = await people();
    const client = who === "owner" ? api : clients.admin;
    expect((await client.delete(`/api/issues/${issue.id}/`)).status).toBe(204);
  });

  it("can_delete is reported per caller, on the issue and on the board", async () => {
    const { clients, api, issue, project } = await people();
    const expected = { reporter: true, member: false, admin: true, viewer: false } as const;
    for (const [who, can] of Object.entries(expected)) {
      const c = clients[who as keyof typeof expected];
      expect((await c.get(`/api/issues/${issue.id}/`)).body.can_delete, who).toBe(can);
      const columns = (await c.get(`/api/boards/${project.board_id}/columns/`)).body.columns;
      const card = columns.flatMap((col: { issues: Array<{ id: number }> }) => col.issues).find((i: { id: number }) => i.id === issue.id);
      expect(card.can_delete, who).toBe(can);
    }
    expect((await api.get(`/api/issues/${issue.id}/`)).body.can_delete).toBe(true);
  });

  it("a member can ask the admins to delete an issue", async () => {
    const { clients, users, owner, issue } = await people();
    const r = await clients.member.post(`/api/issues/${issue.id}/request_deletion/`);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ notified: 2 });
    const notes = await prisma.notification.findMany({ where: { verb: "delete_requested" } });
    expect(new Set(notes.map((n) => n.userId))).toEqual(new Set([users.admin.id, owner.id]));
    expect(notes[0]!.message).toBe(`other asked to delete ${issue.key}: Fix login`);
    expect(outbox.map((m) => m.to[0]).sort()).toEqual(["admin@acme.test", "owner@acme.test"]);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "issue.deletion_requested" } });
    expect(entry.actorId).toBe(users.member.id);
    expect(entry.entityId).toBe(String(issue.id));
    // A second click notifies nobody while the first request is unread.
    const again = await clients.member.post(`/api/issues/${issue.id}/request_deletion/`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ already_requested: true });
    expect(await prisma.notification.count({ where: { verb: "delete_requested" } })).toBe(2);
  });

  it("asking is only for people who can't delete", async () => {
    const { clients, api, issue } = await people();
    expect((await clients.reporter.post(`/api/issues/${issue.id}/request_deletion/`)).status).toBe(400);
    expect((await api.post(`/api/issues/${issue.id}/request_deletion/`)).status).toBe(400);
    expect((await clients.viewer.post(`/api/issues/${issue.id}/request_deletion/`)).status).toBe(403);
    expect(await prisma.notification.count({ where: { verb: "delete_requested" } })).toBe(0);
  });

  it("the admin's notification links to the issue and its project", async () => {
    const { clients, issue } = await people();
    await clients.member.post(`/api/issues/${issue.id}/request_deletion/`);
    const note = (await clients.admin.get("/api/notifications/")).body.results[0];
    expect(note.verb).toBe("delete_requested");
    expect(note.issue).toBe(issue.id);
    expect(note.project).toBe(issue.project);
    expect(note.issue_key).toBe(issue.key);
  });
});
