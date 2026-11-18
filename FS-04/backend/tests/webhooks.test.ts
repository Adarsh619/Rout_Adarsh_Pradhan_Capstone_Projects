import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { outbox } from "../src/lib/mail.js";
import { RetryLater, testing } from "../src/jobs/queue.js";
import { WEBHOOK_EVENTS } from "../src/modules/integrations/events.js";
import { deleteOldWebhookDeliveries, deliverWebhook, http, sendDueDateReminders } from "../src/modules/integrations/jobs.js";
import { checkUrl, dns, UnsafeURL } from "../src/modules/integrations/urlsafety.js";
import { addMember, clientFor, makeUser, move, newIssue, newProject, newSprint, prisma, statusesOf, world, type Client } from "./helpers.js";

// Webhooks, notifications, reports and reminders (v1: test_webhooks, test_integrations).

type Call = { url: string; body: string; headers: Record<string, string> };

// Stand in for the receiving server: answer `response` (a status, or an error to throw) and record each call.
function receiver(response: number | Error, text = "ok") {
  const calls: Call[] = [];
  http.post = async (url, body, headers) => {
    calls.push({ url, body, headers });
    if (response instanceof Error) throw response;
    return new Response(response === 204 ? null : text, { status: response });
  };
  return calls;
}

async function withHook(fields: object = {}) {
  const w = await world();
  const r = await w.api.post("/api/webhooks/", { url: "https://hooks.example.com/in", ...fields });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { ...w, hook: r.body };
}

// Queue a ping, then run its delivery once with the receiver answering `response`.
async function pingOnce(api: Client, hook: { id: number }, response: number | Error, text?: string) {
  testing.held = [];
  await api.post(`/api/webhooks/${hook.id}/ping/`);
  const job = testing.held.pop()!;
  testing.held = null;
  const calls = receiver(response, text);
  let retried = false;
  try {
    await deliverWebhook(job.data as { deliveryId: number });
  } catch (err) {
    if (!(err instanceof RetryLater)) throw err;
    retried = true;
  }
  const delivery = await prisma.webhookDelivery.findFirstOrThrow({ orderBy: { id: "desc" } });
  return { calls, retried, delivery };
}

describe("SSRF protection", () => {
  it.each([
    "http://localhost:8000/admin/", "http://127.0.0.1/", "http://10.0.0.5/hook", "http://192.168.1.10/",
    "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://db:5432/", "http://redis/",
    "ftp://files.example.com/", "https://user:pass@example.com/", "http://app.localhost/", "http://2130706433/",
    "http://[::ffff:10.0.0.1]/", "http://[fe80::1]/",
  ])("refuses %s", async (url) => {
    await expect(checkUrl(url)).rejects.toBeInstanceOf(UnsafeURL);
  });

  it("lets public URLs through, and private ones only when allowed for local testing", async () => {
    await checkUrl("https://hooks.example.com/in");
    await checkUrl("http://93.184.215.14/hook");
    await checkUrl("http://[2606:4700::1111]/hook");
    config.WEBHOOK_ALLOW_PRIVATE_URLS = true;
    await checkUrl("http://localhost:9000/");
  });

  it("the API refuses internal webhook URLs", async () => {
    const { api } = await world();
    const r = await api.post("/api/webhooks/", { url: "http://169.254.169.254/latest/meta-data/" });
    expect(r.status).toBe(400);
    expect(r.body.url).toBeTruthy();
    expect((await api.post("/api/webhooks/", { url: "http://backend:8000/api/" })).status).toBe(400);
    expect((await api.post("/api/webhooks/", { url: "not a url" })).status).toBe(400);
  });

  it("blocks a delivery whose host now resolves to a private address, without retrying", async () => {
    const { api, hook } = await withHook();
    dns.resolve = async () => ["10.1.2.3"]; // e.g. the receiver's DNS changed after the webhook was saved
    const { calls, retried, delivery } = await pingOnce(api, hook, 200);
    expect(calls).toHaveLength(0);
    expect(retried).toBe(false);
    expect(delivery.success).toBe(false);
    expect(delivery.responseBody.startsWith("Not sent:")).toBe(true);
  });

  it("retries a DNS failure", async () => {
    const { api, hook } = await withHook();
    dns.resolve = async () => {
      throw new Error("temporary failure in name resolution");
    };
    const { calls, retried, delivery } = await pingOnce(api, hook, 200);
    expect(calls).toHaveLength(0);
    expect(retried).toBe(true);
    expect(delivery.responseBody).toBe("Not sent: Couldn't resolve hooks.example.com.");
  });

  it("does not follow redirects", async () => {
    const { api, hook } = await withHook();
    const { retried, delivery } = await pingOnce(api, hook, 302, "");
    expect(delivery.success).toBe(false);
    expect(delivery.statusCode).toBe(302);
    expect(retried).toBe(false);
  });
});

describe("delivery", () => {
  it.each([
    [503, true], [429, true], [408, true], [new Error("connection refused"), true], [new Error("timeout"), true],
    [404, false], [400, false], [410, false],
  ] as const)("receiver answers %s: retried %s", async (response, retried) => {
    const { api, hook } = await withHook();
    const result = await pingOnce(api, hook, response as number | Error);
    expect(result.retried).toBe(retried);
    expect(result.delivery.attempts).toBe(1);
    expect(result.delivery.success).toBe(false);
  });

  it("stops retrying after five attempts", async () => {
    const { api, hook } = await withHook();
    const { delivery } = await pingOnce(api, hook, 503);
    await prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { attempts: 4 } });
    receiver(503);
    await expect(deliverWebhook({ deliveryId: delivery.id })).resolves.toBe(false);
    expect((await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).attempts).toBe(5);
  });

  it("inline mode tries five times in total", async () => {
    const { api, hook } = await withHook();
    const calls = receiver(500);
    await api.post(`/api/webhooks/${hook.id}/ping/`);
    expect(calls).toHaveLength(5);
  });

  it("deliveries are signed with HMAC-SHA256 and sent only for subscribed events", async () => {
    const { api, hook } = await withHook({ events: ["issue.created"] });
    const calls = receiver(200);
    const project = await newProject(api);
    await newIssue(api, project, { title: "Hooked" });
    expect(calls).toHaveLength(1);
    const { body, headers } = calls[0]!;
    expect(headers["X-TaskFlow-Signature"]).toBe("sha256=" + createHmac("sha256", hook.secret).update(body).digest("hex"));
    expect(headers["X-TaskFlow-Event"]).toBe("issue.created");
    const payload = JSON.parse(body);
    expect(payload).toMatchObject({ event: "issue.created", workspace: "acme" });
    expect(payload.data.entity.label).toBe("WEB-1 Hooked");
    const d = await prisma.webhookDelivery.findFirstOrThrow();
    expect(d.success).toBe(true);
    expect(d.attempts).toBe(1);
  });

  it("no request for an unsubscribed event", async () => {
    const { api } = await withHook({ events: ["comment.created"] });
    const calls = receiver(200);
    await newIssue(api, await newProject(api), { title: "x" });
    expect(calls).toHaveLength(0);
  });

  it("the event list matches what the app actually sends", async () => {
    const { api, workspace } = await withHook();
    const project = await newProject(api);
    const statuses = await statusesOf(workspace);
    const wf = (await api.post("/api/workflows/", { name: "Support" })).body;
    await api.patch(`/api/workflows/${wf.id}/`, { name: "Support desk" });
    const s1 = (await api.post("/api/statuses/", { workflow: wf.id, name: "Open" })).body;
    const s2 = (await api.post("/api/statuses/", { workflow: wf.id, name: "Closed" })).body;
    await api.patch(`/api/statuses/${s1.id}/`, { name: "New" });
    const t = (await api.post("/api/transitions/", { workflow: wf.id, from_status: s1.id, to_status: s2.id })).body;
    await api.delete(`/api/transitions/${t.id}/`);
    await api.delete(`/api/statuses/${s2.id}/`);
    await api.delete(`/api/workflows/${wf.id}/`);
    const p2 = (await api.post("/api/projects/", { key: "OPS", name: "Ops" })).body;
    await api.patch(`/api/projects/${p2.id}/`, { name: "Operations" });
    const b = (await api.post("/api/boards/", { project: p2.id, name: "Extra" })).body;
    await api.patch(`/api/boards/${b.id}/`, { name: "Extra board" });
    await api.delete(`/api/boards/${b.id}/`);
    await api.delete(`/api/projects/${p2.id}/`);
    const s = await newSprint(api, project);
    await api.patch(`/api/sprints/${s.id}/`, { goal: "Ship it" });
    await api.post(`/api/sprints/${s.id}/start/`);
    await api.post(`/api/sprints/${s.id}/complete/`);
    await api.delete(`/api/sprints/${s.id}/`);
    const issue = await newIssue(api, project);
    await api.patch(`/api/issues/${issue.id}/`, { title: "Renamed" });
    await move(api, issue.id, statuses[1]!);
    const c = (await api.post("/api/comments/", { issue: issue.id, body: "hi" })).body;
    await api.patch(`/api/comments/${c.id}/`, { body: "hello" });
    await api.delete(`/api/comments/${c.id}/`);
    const a = (await api.post("/api/attachments/").field("issue", String(issue.id)).attach("file", Buffer.from("x"), "a.txt")).body;
    await api.delete(`/api/attachments/${a.id}/`);
    await api.delete(`/api/issues/${issue.id}/`);
    await makeUser("new@acme.test");
    const m = (await api.post("/api/members/", { email: "new@acme.test", role: "member" })).body;
    await api.patch(`/api/members/${m.id}/`, { role: "viewer" });
    await api.delete(`/api/members/${m.id}/`);
    const leaver = await addMember(workspace, "leaver@acme.test", "member");
    await (await clientFor(leaver, workspace)).post("/api/members/leave/");

    const sent = new Set((await prisma.webhookDelivery.findMany({ select: { event: true } })).map((d) => d.event));
    expect(sent).toEqual(new Set(WEBHOOK_EVENTS));
  });
});

describe("managing webhooks", () => {
  it("is for admins only", async () => {
    const { workspace } = await world();
    const m = await addMember(workspace, "m@acme.test", "member");
    expect((await (await clientFor(m, workspace)).get("/api/webhooks/")).status).toBe(403);
  });

  it("can subscribe to member events; unknown events are refused", async () => {
    const { api } = await world();
    const r = await api.post("/api/webhooks/", { url: "https://hooks.example.com/in", events: ["member.added", "sprint.created"] });
    expect(r.status).toBe(201);
    expect(r.body.events).toEqual(["member.added", "sprint.created"]);
    expect((await api.post("/api/webhooks/", { url: "https://hooks.example.com/in", events: ["nope"] })).status).toBe(400);
    expect((await api.get("/api/webhooks/events/")).body).toEqual([...WEBHOOK_EVENTS]);
  });

  it("rotating the secret is audited without logging the secret, and signs from then on", async () => {
    const { api, hook } = await withHook();
    const r = await api.post(`/api/webhooks/${hook.id}/rotate_secret/`);
    expect(r.status).toBe(200);
    expect(r.body.secret).not.toBe(hook.secret);
    expect(r.body.secret.startsWith("whsec_")).toBe(true);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "webhook.secret_rotated" } });
    expect(JSON.stringify(entry.changes)).not.toContain(r.body.secret);
    expect(JSON.stringify(entry.changes)).not.toContain(hook.secret);
    const { calls } = await pingOnce(api, hook, 200);
    const sig = "sha256=" + createHmac("sha256", r.body.secret).update(calls[0]!.body).digest("hex");
    expect(calls[0]!.headers["X-TaskFlow-Signature"]).toBe(sig);
  });

  it("changes are audited", async () => {
    const { api, hook } = await withHook();
    await api.patch(`/api/webhooks/${hook.id}/`, { is_active: false });
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: "webhook.updated" } })).changes).toEqual({ is_active: [true, false] });
    await api.delete(`/api/webhooks/${hook.id}/`);
    const deleted = await prisma.auditLog.findFirstOrThrow({ where: { action: "webhook.deleted" } });
    expect((deleted.changes as { url: string }).url).toBe(hook.url);
  });

  it("a failed delivery shows the response and can be redelivered", async () => {
    const { api, hook } = await withHook();
    const { delivery: failed } = await pingOnce(api, hook, 404, "no such hook");
    const log = (await api.get(`/api/webhooks/${hook.id}/deliveries/`)).body;
    expect(log[0].response_body).toBe("no such hook");
    expect(log[0].status_code).toBe(404);
    receiver(200);
    const r = await api.post(`/api/webhooks/${hook.id}/redeliver/`, { delivery: failed.id });
    expect(r.status).toBe(202);
    const again = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: r.body.delivery } });
    expect(again.success).toBe(true);
    expect(again.payload).toEqual(failed.payload);
    expect(again.event).toBe("ping");
    expect((await api.post(`/api/webhooks/${hook.id}/redeliver/`, { delivery: 999999 })).status).toBe(400);
  });
});

describe("jobs", () => {
  it("old deliveries are cleaned up", async () => {
    const { api, hook } = await withHook();
    config.WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
    const { delivery: old } = await pingOnce(api, hook, 200);
    const { delivery: recent } = await pingOnce(api, hook, 200);
    await prisma.webhookDelivery.update({ where: { id: old.id }, data: { createdAt: new Date(Date.now() - 31 * 86_400_000) } });
    expect(await deleteOldWebhookDeliveries()).toBe(1);
    expect((await prisma.webhookDelivery.findMany()).map((d) => d.id)).toEqual([recent.id]);
  });

  it("due-date reminders are sent once a day", async () => {
    const { api, workspace } = await world();
    const member = await addMember(workspace, "member@acme.test", "member");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await newIssue(api, await newProject(api), { title: "Due", assignee: member.id, due_date: tomorrow });
    expect(await sendDueDateReminders()).toBe(1);
    expect(await sendDueDateReminders()).toBe(0); // e.g. the worker restarted and ran the job again
    const notes = await prisma.notification.findMany({ where: { userId: member.id, verb: "due_soon" } });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toBe(`WEB-1 is due on ${tomorrow}: Due`);
  });

  it("generates a report on demand and emails the admins", async () => {
    const { api, workspace } = await world();
    await newIssue(api, await newProject(api), { title: "x" });
    const r = await api.post("/api/reports/generate/");
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("queued");
    const report = await prisma.report.findFirstOrThrow({ where: { workspaceId: workspace.id } });
    expect(report.data).toMatchObject({ created: 1, open_total: 1 });
    expect(outbox.some((m) => m.subject.includes("Weekly summary"))).toBe(true);
    expect((await api.get("/api/reports/")).body.results[0].id).toBe(report.id);
  });

  it("reports: members read, only admins generate", async () => {
    const { workspace } = await world();
    const member = await clientFor(await addMember(workspace, "m@acme.test", "member"), workspace);
    const viewer = await clientFor(await addMember(workspace, "v@acme.test", "viewer"), workspace);
    expect((await member.get("/api/reports/")).status).toBe(200);
    expect((await member.post("/api/reports/generate/")).status).toBe(403);
    expect((await viewer.get("/api/reports/")).status).toBe(403);
  });

  it("notifications: filter by read state, mark one read", async () => {
    const { api, workspace } = await world();
    const member = await addMember(workspace, "m@acme.test", "member");
    await newIssue(api, await newProject(api), { assignee: member.id });
    const mc = await clientFor(member, workspace);
    const unread = (await mc.get("/api/notifications/?read=false")).body.results;
    expect(unread).toHaveLength(1);
    expect((await mc.patch(`/api/notifications/${unread[0].id}/`, { read: true })).body.read).toBe(true);
    expect((await mc.get("/api/notifications/?read=false")).body.count).toBe(0);
    // Someone else's notification is not found.
    expect((await api.patch(`/api/notifications/${unread[0].id}/`, { read: false })).status).toBe(404);
  });
});
