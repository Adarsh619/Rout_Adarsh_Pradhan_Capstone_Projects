import { createHmac } from "node:crypto";
import { config } from "../../config.js";
import { inTransaction, prisma } from "../../lib/db.js";
import { addDays, today } from "../../lib/http.js";
import { sendMail } from "../../lib/mail.js";
import { enqueue, RetryLater } from "../../jobs/queue.js";
import { notifyIssueEvent } from "./notify.js";
import { checkUrl, HostLookupFailed, UnsafeURL } from "./urlsafety.js";

// Background jobs for integrations: webhook delivery, notification emails, reports and reminders.

export const MAX_ATTEMPTS = 5;
// Plus every 5xx; other 3xx/4xx answers won't change by asking again.
const RETRYABLE_STATUS = new Set([408, 429]);

export const sign = (secret: string, body: string): string =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

// Tests replace this to stand in for the receiving server.
export const http = {
  post: (url: string, body: string, headers: Record<string, string>) =>
    fetch(url, { method: "POST", body, headers, redirect: "manual", signal: AbortSignal.timeout(10_000) }),
};

// Send one delivery. Throws RetryLater when the queue should try again (30 s, 60 s, 120 s, 240 s later).
export async function deliverWebhook({ deliveryId }: { deliveryId: number }): Promise<boolean | undefined> {
  const d = await prisma.webhookDelivery.findUnique({ where: { id: deliveryId }, include: { webhook: true } });
  if (!d || d.success) return undefined;
  const body = JSON.stringify(d.payload);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "TaskFlow-Webhooks/2.0",
    "X-TaskFlow-Event": d.event,
    "X-TaskFlow-Delivery": String(d.id),
    "X-TaskFlow-Signature": sign(d.webhook.secret, body),
  };
  const attempts = d.attempts + 1;
  let statusCode: number | null = d.statusCode;
  let responseBody: string;
  let success = false;
  let retryable: boolean;
  try {
    // Re-checked on every attempt: the host's DNS may now point somewhere internal.
    await checkUrl(d.webhook.url, true);
    // No redirects: a public URL could otherwise bounce the request to an internal one.
    const res = await http.post(d.webhook.url, body, headers);
    statusCode = res.status;
    responseBody = (await res.text()).slice(0, 2000);
    success = res.status >= 200 && res.status < 300;
    retryable = res.status >= 500 || RETRYABLE_STATUS.has(res.status);
  } catch (err) {
    if (err instanceof UnsafeURL) {
      responseBody = `Not sent: ${err.message}`;
      retryable = err instanceof HostLookupFailed; // DNS may come back; a private address won't change
    } else {
      // Timeouts, refused connections, TLS errors.
      responseBody = String((err as Error)?.message ?? err).slice(0, 2000);
      retryable = true;
    }
  }
  await prisma.webhookDelivery.update({
    where: { id: d.id },
    data: { attempts, statusCode, responseBody, success, deliveredAt: success ? new Date() : null },
  });
  if (retryable && attempts < MAX_ATTEMPTS) throw new RetryLater(`delivery ${d.id}: attempt ${attempts} failed`);
  return success;
}

// Daily: drop delivery logs older than WEBHOOK_DELIVERY_RETENTION_DAYS so the table doesn't grow forever.
export async function deleteOldWebhookDeliveries(): Promise<number> {
  const cutoff = new Date(Date.now() - config.WEBHOOK_DELIVERY_RETENTION_DAYS * 86_400_000);
  return (await prisma.webhookDelivery.deleteMany({ where: { createdAt: { lt: cutoff } } })).count;
}

export async function sendNotificationEmails({ ids }: { ids: number[] }): Promise<number> {
  const notes = await prisma.notification.findMany({ where: { id: { in: ids } }, include: { user: true, workspace: true } });
  for (const n of notes) {
    await sendMail({ to: [n.user.email], subject: `[${n.workspace.name}] ${n.message.slice(0, 80)}`, text: n.message });
  }
  return ids.length;
}

export async function buildWeeklyReport(workspaceId: number) {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const notDone = { workspaceId, status: { category: { not: "done" as const } } };
  const moved = await prisma.auditLog.findMany({
    where: { workspaceId, action: "issue.moved", createdAt: { gte: since } },
    select: { entityId: true },
  });
  const doneIds = [...new Set(moved.map((m) => Number(m.entityId)))].filter(Number.isSafeInteger);
  const [created, completed, openTotal, overdue, open] = await Promise.all([
    prisma.issue.count({ where: { workspaceId, createdAt: { gte: since } } }),
    prisma.issue.count({ where: { workspaceId, id: { in: doneIds }, status: { category: "done" } } }),
    prisma.issue.count({ where: notDone }),
    prisma.issue.count({ where: { ...notDone, dueDate: { lt: today() } } }),
    prisma.issue.groupBy({ by: ["assigneeId"], where: notDone, _count: { _all: true } }),
  ]);
  const users = await prisma.user.findMany({
    where: { id: { in: open.map((o) => o.assigneeId).filter((x): x is number => x !== null) } },
    select: { id: true, email: true },
  });
  const email = new Map(users.map((u) => [u.id, u.email]));
  const byAssignee = open
    .map((o) => ({ open: o._count._all, assignee__email: o.assigneeId === null ? null : (email.get(o.assigneeId) ?? null) }))
    .sort((a, b) => b.open - a.open)
    .slice(0, 10);
  return {
    period_start: since.toISOString().slice(0, 10),
    period_end: today().toISOString().slice(0, 10),
    created,
    completed,
    open_total: openTotal,
    overdue,
    open_by_assignee: byAssignee,
  };
}

export async function generateWeeklyReport({ workspaceId }: { workspaceId: number }): Promise<number | undefined> {
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return undefined;
  const data = await buildWeeklyReport(ws.id);
  const report = await prisma.report.create({ data: { workspaceId: ws.id, kind: "weekly_summary", data } });
  const admins = await prisma.membership.findMany({
    where: { workspaceId: ws.id, role: { in: ["owner", "admin"] } },
    include: { user: { select: { email: true } } },
  });
  await sendMail({ to: admins.map((m) => m.user.email), subject: `[${ws.name}] Weekly summary`, text: JSON.stringify(data, null, 2) });
  return report.id;
}

export async function generateAllWeeklyReports(): Promise<number> {
  const ids = (await prisma.workspace.findMany({ select: { id: true } })).map((w) => w.id);
  for (const workspaceId of ids) await enqueue("generate_weekly_report", { workspaceId });
  return ids.length;
}

export async function sendDueDateReminders(): Promise<number> {
  const start = today();
  const tomorrow = addDays(start, 1);
  // Skip issues already reminded today, so a scheduler restart or a manual re-run doesn't email people twice.
  const reminded = await prisma.notification.findMany({
    where: { verb: "due_soon", createdAt: { gte: start, lt: tomorrow } },
    select: { issueId: true },
  });
  const issues = await prisma.issue.findMany({
    where: {
      dueDate: tomorrow,
      assigneeId: { not: null },
      status: { category: { not: "done" } },
      id: { notIn: reminded.map((n) => n.issueId).filter((x): x is number => x !== null) },
    },
    include: { project: { select: { key: true } }, status: true },
  });
  for (const issue of issues) await inTransaction((unit) => notifyIssueEvent(unit, issue, "due_soon"));
  return issues.length;
}
