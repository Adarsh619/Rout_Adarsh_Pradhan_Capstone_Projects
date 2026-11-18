import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { stats } from "../src/lib/db.js";
import { SCHEDULE } from "../src/jobs/registry.js";
import { checkPassword } from "../src/modules/auth/passwords.js";
import { purgeVisitorData, resetDemoData } from "../src/modules/demo/jobs.js";
import { SeedRefused, seedDemo } from "../src/modules/demo/seed.js";
import { anon, clientFor, createWorkspace, makeUser, prisma } from "./helpers.js";

// The public demo site (DEMO_MODE), the demo seed and the board performance guard
// (v1: test_demo_mode, test_seed_and_perf).

function demoMode() {
  config.DEMO_MODE = true;
  config.debug = false;
}

// The board must load in a fixed number of SQL statements, however many issues it shows.
const BOARD_QUERY_BUDGET = 11;

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);

describe("demo logins", () => {
  it("can't change their password or profile on the live site", async () => {
    demoMode();
    const owner = await makeUser("owner@acme.test"); // a published demo login
    const c = await clientFor(owner);
    const r = await c.post("/api/auth/password/", { current_password: "pass12345", new_password: "Brand-new-pass-42" });
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain("shared demo account");
    expect((await c.patch("/api/auth/me/", { full_name: "Hijacked" })).status).toBe(403);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.id } });
    expect(await checkPassword("pass12345", after.password)).toBe(true);
    expect(after.fullName).not.toBe("Hijacked");
  });

  it("visitor accounts work normally in demo mode", async () => {
    demoMode();
    const c = await clientFor(await makeUser("visitor@example.com"));
    expect((await c.patch("/api/auth/me/", { full_name: "Vee" })).status).toBe(200);
    expect((await c.post("/api/auth/password/", { current_password: "pass12345", new_password: "Brand-new-pass-42" })).status).toBe(200);
  });

  it("are ordinary accounts when demo mode is off", async () => {
    const r = await (await clientFor(await makeUser("owner@acme.test"))).patch("/api/auth/me/", { full_name: "Olivia" });
    expect(r.status).toBe(200);
    expect(r.body.demo_mode).toBe(false);
    expect(r.body.is_demo_account).toBe(false);
  });

  it("/me tells the app about the demo", async () => {
    demoMode();
    const me = (await (await clientFor(await makeUser("owner@acme.test"))).get("/api/auth/me/")).body;
    expect(me).toMatchObject({ demo_mode: true, is_demo_account: true });
    const visitor = (await (await clientFor(await makeUser("visitor@example.com"))).get("/api/auth/me/")).body;
    expect(visitor).toMatchObject({ demo_mode: true, is_demo_account: false });
  });
});

describe("nightly reset and visitor clean-up", () => {
  it("the nightly reset rebuilds vandalised demo data", async () => {
    demoMode();
    await resetDemoData({ issues: 2 });
    let acme = await prisma.workspace.findUniqueOrThrow({ where: { slug: "acme" } });
    await prisma.issue.deleteMany({ where: { workspaceId: acme.id } });
    await prisma.project.deleteMany({ where: { workspaceId: acme.id } }); // a visitor wrecks the demo
    await prisma.user.update({ where: { email: "owner@acme.test" }, data: { password: "changed-by-someone" } });

    await resetDemoData({ issues: 2 });
    acme = await prisma.workspace.findUniqueOrThrow({ where: { slug: "acme" } });
    expect(await prisma.project.count({ where: { workspaceId: acme.id } })).toBe(2);
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@acme.test" } });
    expect(await checkPassword("demo12345", owner.password)).toBe(true);
  });

  it("the purge removes old visitor data only", async () => {
    demoMode();
    await resetDemoData({ issues: 2 });
    const oldVisitor = await makeUser("old@example.com");
    const oldWs = await createWorkspace("Old Co", oldVisitor);
    await prisma.workspace.update({ where: { id: oldWs.id }, data: { createdAt: ago(8) } });
    await prisma.user.update({ where: { id: oldVisitor.id }, data: { dateJoined: ago(8) } });
    const newVisitor = await makeUser("new@example.com");
    const newWs = await createWorkspace("New Co", newVisitor);
    await prisma.workspace.update({ where: { slug: "acme" }, data: { createdAt: ago(30) } }); // demo data is never purged

    expect(await purgeVisitorData()).toBe("purged 1 workspaces, 1 accounts");
    expect(await prisma.workspace.count({ where: { id: oldWs.id } })).toBe(0);
    expect(await prisma.user.count({ where: { email: "old@example.com" } })).toBe(0);
    expect(await prisma.workspace.count({ where: { id: newWs.id } })).toBe(1);
    expect(await prisma.user.count({ where: { id: newVisitor.id } })).toBe(1);
    expect(await prisma.workspace.count({ where: { slug: "acme" } })).toBe(1);
    expect(await prisma.user.count({ where: { email: "owner@acme.test" } })).toBe(1);
  });

  it("housekeeping does nothing outside demo mode", async () => {
    const ws = await createWorkspace("Old Co", await makeUser("old@example.com"));
    await prisma.workspace.update({ where: { id: ws.id }, data: { createdAt: ago(30) } });
    expect((await resetDemoData({ issues: 2 })).startsWith("skipped")).toBe(true);
    expect((await purgeVisitorData()).startsWith("skipped")).toBe(true);
    expect(await prisma.workspace.count({ where: { id: ws.id } })).toBe(1);
    expect(await prisma.workspace.count({ where: { slug: "acme" } })).toBe(0);
  });

  it("the reset is scheduled nightly at 21:00 UTC", () => {
    expect(SCHEDULE.find((s) => s.name === "reset_demo_data")?.pattern).toBe("0 21 * * *");
  });

  it("health reports the deployed version without touching the database", async () => {
    config.APP_VERSION = "abc1234";
    const before = stats.queries;
    const r = await (await anon()).get("/api/health/");
    expect(r.body).toEqual({ status: "ok", version: "abc1234" });
    expect(stats.queries).toBe(before);
  });
});

describe("demo seed", () => {
  it("creates two isolated workspaces, and --reset rebuilds them", async () => {
    await seedDemo({ issues: 8 });
    expect(await prisma.workspace.count({ where: { slug: { in: ["acme", "globex"] } } })).toBe(2);
    expect(await prisma.issue.count({ where: { workspace: { slug: "acme" } } })).toBe(16);
    await seedDemo({ issues: 3, reset: true }); // must work with append-only audit entries
    expect(await prisma.issue.count({ where: { workspace: { slug: "acme" } } })).toBe(6);
  });

  it("refuses to run in production", async () => {
    config.debug = false;
    await expect(seedDemo({ issues: 1 })).rejects.toBeInstanceOf(SeedRefused);
    expect(await prisma.workspace.count()).toBe(0);
  });

  it("seeded data follows the app's rules", async () => {
    await seedDemo({ issues: 10 });
    const acme = await prisma.workspace.findUniqueOrThrow({ where: { slug: "acme" } });
    const members = await prisma.membership.findMany({ where: { workspaceId: acme.id } });
    expect(new Set(members.map((m) => m.role))).toEqual(new Set(["owner", "admin", "member", "viewer"]));
    const viewer = members.find((m) => m.role === "viewer")!.userId;
    expect(await prisma.issue.count({ where: { OR: [{ reporterId: viewer }, { assigneeId: viewer }] } })).toBe(0);
    expect(await prisma.comment.count({ where: { authorId: viewer } })).toBe(0);
    expect(await prisma.issue.count({ where: { sprint: { state: "closed" }, status: { category: { not: "done" } } } })).toBe(0);
    const people = new Set(members.map((m) => m.userId));
    const issues = await prisma.issue.findMany({ where: { workspaceId: acme.id }, include: { status: true, project: true } });
    expect(issues.every((i) => i.reporterId && people.has(i.reporterId))).toBe(true);
    expect(issues.every((i) => i.status.workspaceId === acme.id && i.status.workflowId === i.project.workflowId)).toBe(true);
  });

  it("includes a realistic history", async () => {
    await seedDemo({ issues: 10 });
    const acme = await prisma.workspace.findUniqueOrThrow({ where: { slug: "acme" } });
    const issues = await prisma.issue.findMany({ where: { workspaceId: acme.id }, include: { status: true } });
    const log = { workspaceId: acme.id };
    expect(await prisma.auditLog.count({ where: { ...log, action: "issue.created" } })).toBe(issues.length);
    for (const issue of issues.filter((i) => i.status.category === "done").slice(0, 3)) {
      const moves = await prisma.auditLog.findMany({ where: { ...log, action: "issue.moved", entityId: String(issue.id) }, orderBy: { id: "asc" } });
      expect(moves.map((m) => (m.changes as { status: string[] }).status[1])).toEqual(["In Progress", "In Review", "Done"]);
    }
    expect(await prisma.auditLog.count({ where: { ...log, action: "comment.created" } })).toBe(await prisma.comment.count({ where: log }));
    expect(await prisma.auditLog.count({ where: { ...log, action: "member.added" } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { ...log, actorEmail: "" } })).toBe(0);
    expect(await prisma.sprint.count({ where: { ...log, state: "closed" } })).toBe(2);
    expect(await prisma.notification.count({ where: { ...log, read: false } })).toBeGreaterThan(0);
    const report = await prisma.report.findFirstOrThrow({ where: log });
    expect((report.data as { open_total: number }).open_total).toBe(issues.filter((i) => i.status.category !== "done").length);
  });
});

describe("performance", () => {
  it("the board's query count doesn't grow with its issues", async () => {
    await seedDemo({ issues: 60 });
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: "owner@acme.test" } });
    const c = await clientFor(owner, "acme");
    const board = await prisma.board.findFirstOrThrow({ where: { workspace: { slug: "acme" }, project: { key: "WEB" } } });
    const url = `/api/boards/${board.id}/columns/?sprint=all`;
    await c.get(url); // warm-up

    const measure = async () => {
      const before = stats.queries;
      const start = performance.now();
      const r = await c.get(url);
      const ms = performance.now() - start;
      expect(r.status).toBe(200);
      const shown = r.body.columns.reduce((n: number, col: { issues: unknown[] }) => n + col.issues.length, 0);
      return { queries: stats.queries - before, shown, ms };
    };
    const sixty = await measure();
    if (process.env.SHOW_SQL) console.log(stats.recent.slice(-sixty.queries).map((q) => q.slice(0, 140)).join(String.fromCharCode(10)));
    expect(sixty.shown).toBe(60);
    await prisma.issue.deleteMany({ where: { projectId: board.projectId, number: { gt: 20 } } });
    const twenty = await measure();
    expect(twenty.shown).toBe(20);
    console.log(`[perf] board with 60 issues: ${sixty.queries} queries, ${sixty.ms.toFixed(1)} ms (warm)`);
    expect(sixty.queries).toBe(twenty.queries);
    expect(sixty.queries).toBeLessThanOrEqual(BOARD_QUERY_BUDGET);
  });
});
