import express from "express";
import supertest from "supertest";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { clientIp } from "../src/modules/audit/service.js";
import { deleteWorkspace } from "../src/modules/tenancy/services.js";
import { addMember, anon, clientFor, makeUser, newIssue, newProject, prisma, world } from "./helpers.js";

// The audit log (v1: test_audit).

const today = () => new Date().toISOString().slice(0, 10);

describe("client IP", () => {
  // Express applies TRUSTED_PROXY_COUNT through "trust proxy"; supertest connects from 127.0.0.1.
  it.each([
    [0, "1.2.3.4", "127.0.0.1"], // no proxy: the header is ignored
    [1, "1.2.3.4, 203.0.113.9", "203.0.113.9"], // the browser-sent value on the left is ignored
    [1, "203.0.113.9", "203.0.113.9"],
    [1, null, "127.0.0.1"], // proxy configured but no header: the direct peer
    [2, "1.2.3.4, 198.51.100.7, 172.18.0.8", "198.51.100.7"],
    [1, "not-an-ip", null],
  ])("trusting %i proxies, X-Forwarded-For %s gives %s", async (trusted, forwarded, expected) => {
    const app = express();
    app.set("trust proxy", trusted);
    app.get("/", (req, res) => void res.json({ ip: clientIp(req) }));
    const t = supertest(app).get("/");
    if (forwarded) t.set("X-Forwarded-For", forwarded);
    expect((await t).body.ip).toBe(expected);
  });

  it("does not record a spoofed X-Forwarded-For", async () => {
    config.TRUSTED_PROXY_COUNT = 1;
    const { api } = await world();
    const r = await api.post("/api/projects/", { key: "IP", name: "IP test" }).set("X-Forwarded-For", "6.6.6.6, 203.0.113.9");
    expect(r.status).toBe(201);
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "project.created" } })).ipAddress).toBe("203.0.113.9");
  });

  it("the login rate limit ignores a spoofed X-Forwarded-For", async () => {
    await makeUser("owner@acme.test");
    config.AUTH_RATE_LIMIT = "3/minute";
    const c = await anon();
    const codes = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await c.post("/api/auth/token/", { email: "owner@acme.test", password: "wrong" }).set("X-Forwarded-For", `9.9.9.${i}`)).status);
    }
    expect(codes).toEqual([401, 401, 401, 429]); // a new fake IP per attempt doesn't reset the limit
  });
});

describe("append-only", () => {
  it("entries cannot be changed or deleted, even directly in the database", async () => {
    const { api } = await world();
    await newProject(api);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "project.created" } });
    await expect(prisma.auditLog.update({ where: { id: entry.id }, data: { action: "project.hidden" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: entry.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.updateMany({ data: { action: "x" } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.deleteMany()).rejects.toThrow(/append-only/);
    expect((await prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } })).action).toBe("project.created");
  });

  it("there is no API route to change or delete an entry", async () => {
    const { api } = await world();
    await newProject(api);
    const entry = await prisma.auditLog.findFirstOrThrow();
    expect((await api.patch(`/api/audit-logs/${entry.id}/`, { action: "x" })).status).toBe(404);
    expect((await api.delete(`/api/audit-logs/${entry.id}/`)).status).toBe(404);
  });

  it("deleting a workspace still removes its entries", async () => {
    const { api, workspace } = await world();
    await newProject(api);
    await deleteWorkspace(workspace.id);
    expect(await prisma.auditLog.count()).toBe(0);
  });

  it("an entry keeps the actor's email after the user is deleted", async () => {
    const { api, workspace } = await world();
    const project = await newProject(api);
    const m = await addMember(workspace, "leaving@acme.test", "member");
    await newIssue(await clientFor(m, workspace), project, { title: "x" });
    let entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "issue.created" } });
    expect(entry.actorId).toBe(m.id);
    expect(entry.actorEmail).toBe("leaving@acme.test");
    await prisma.user.delete({ where: { id: m.id } });
    entry = await prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } });
    expect(entry.actorId).toBeNull();
    expect(entry.actorEmail).toBe("leaving@acme.test");
  });
});

describe("audit log page", () => {
  // A project, a sprint, two issues (one by a member) and a member added.
  async function busyLog() {
    const w = await world();
    const project = await newProject(w.api);
    await w.api.post("/api/sprints/", { project: project.id, name: "S1" });
    await newIssue(w.api, project, { title: "Owner issue" });
    const m = await addMember(w.workspace, "meera@acme.test", "member");
    await newIssue(await clientFor(m, w.workspace), project, { title: "Meera issue" });
    return { ...w, project, member: m };
  }
  const actions = async (api: Awaited<ReturnType<typeof world>>["api"], query: string) => {
    const r = await api.get(`/api/audit-logs/?${query}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.results.map((e: { action: string }) => e.action);
  };

  it("filters by kind, person, search and dates", async () => {
    const { api } = await busyLog();
    expect(new Set(await actions(api, "kind=issue"))).toEqual(new Set(["issue.created"]));
    expect(await actions(api, "kind=sprint")).toEqual(["sprint.created"]);
    expect(await actions(api, "actor_email=MEERA@acme.test")).toEqual(["issue.created"]);
    expect(await actions(api, "search=meera@acme")).toEqual(["issue.created"]);
    expect((await actions(api, `since=${today()}&until=${today()}`)).length).toBe(await prisma.auditLog.count());
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(await actions(api, `until=${yesterday}`)).toEqual([]);
    expect((await api.get("/api/audit-logs/?since=yesterday")).status).toBe(400);
  });

  it("pages, and shows IP addresses only to admins", async () => {
    const { api, workspace, member } = await busyLog();
    const r = await api.get("/api/audit-logs/?limit=2&offset=0");
    expect(r.body.count).toBe(await prisma.auditLog.count());
    expect(r.body.results).toHaveLength(2);
    expect(r.body.next).toContain("offset=2");
    expect(r.body.results[0]).toHaveProperty("ip_address");
    const issueId = (await prisma.auditLog.findFirstOrThrow({ where: { action: "issue.created" } })).entityId;
    const history = (await (await clientFor(member, workspace)).get(`/api/issues/${issueId}/history/`)).body;
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]).not.toHaveProperty("ip_address");
  });

  it("exports CSV that respects filters and neutralises formulas", async () => {
    const { api, workspace } = await world();
    const project = await newProject(api);
    await newIssue(api, project, { title: "Normal issue" });
    // A sprint's audit label is its bare name, so a name that looks like a formula starts the cell.
    await api.post("/api/sprints/", { project: project.id, name: '=HYPERLINK("http://evil")' });

    const r = await api.get("/api/audit-logs/export/?kind=issue");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/csv/);
    expect(r.headers["content-disposition"]).toContain('filename="audit-log-acme.csv"');
    const rows = r.text.trim().split("\r\n").map((l) => l.split(","));
    expect(rows[0]!.slice(0, 3)).toEqual(["time (UTC)", "who", "action"]);
    expect(rows.slice(1).map((row) => row[2])).toEqual(["issue.created"]);
    expect(rows[1]![1]).toBe("owner@acme.test");

    const sprint = (await api.get("/api/audit-logs/export/?kind=sprint")).text;
    expect(sprint).toContain(`"'=HYPERLINK(""http://evil"")"`); // in Excel it's text, not a live formula

    const member = await addMember(workspace, "m@acme.test", "member");
    expect((await (await clientFor(member, workspace)).get("/api/audit-logs/export/")).status).toBe(403);
  });
});
