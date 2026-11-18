import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Notification, Report, Webhook, WebhookDelivery } from "../../generated/prisma/client.js";
import { inTransaction, prisma } from "../../lib/db.js";
import { badRequest } from "../../lib/errors.js";
import { iso, queryBool, routeId } from "../../lib/http.js";
import { parse, patchOf } from "../../lib/validate.js";
import { enqueue } from "../../jobs/queue.js";
import { entity } from "../audit/entities.js";
import { diff, record } from "../audit/service.js";
import { currentUser } from "../auth/middleware.js";
import { need, useWorkspace, ws } from "../tenancy/context.js";
import { own, sendPage } from "../tracker/common.js";
import { generateSecret, queueDelivery, WEBHOOK_EVENTS, type Payload } from "./events.js";
import { checkUrl, UnsafeURL } from "./urlsafety.js";

// ── Webhooks (admins only; changes are audited but not sent to webhooks themselves) ───────────────────────────

export const webhookOut = (h: Webhook) => ({
  id: h.id,
  url: h.url,
  events: h.events,
  secret: h.secret,
  is_active: h.isActive,
  created_at: iso(h.createdAt),
});

const deliveryOut = (d: WebhookDelivery) => ({
  id: d.id,
  webhook: d.webhookId,
  event: d.event,
  payload: d.payload,
  status_code: d.statusCode,
  response_body: d.responseBody,
  success: d.success,
  attempts: d.attempts,
  created_at: iso(d.createdAt),
  delivered_at: iso(d.deliveredAt),
});

const webhookShape = {
  url: z.url({ error: "Enter a valid URL." }).max(500),
  events: z.array(z.enum(WEBHOOK_EVENTS)),
  is_active: z.boolean(),
};
const webhookBody = z.object({ ...webhookShape, events: webhookShape.events.default([]), is_active: z.boolean().default(true) });
const webhookPatch = patchOf(webhookShape);

// The host's DNS is checked again before every delivery (see urlsafety.ts).
async function safeUrl(url: string | undefined) {
  if (url === undefined) return;
  try {
    await checkUrl(url);
  } catch (err) {
    if (err instanceof UnsafeURL) throw badRequest({ url: err.message });
    throw err;
  }
}

export function webhooksRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  r.use((req, _res, next) => (need(req, "admin"), next()));
  const find = (req: Request) => own(prisma.webhook.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id } }));

  r.get("/", (req, res) => sendPage(req, res, prisma.webhook, { workspaceId: ws(req).id }, { id: "asc" }, webhookOut));
  r.get("/events/", (_req, res) => {
    res.json(WEBHOOK_EVENTS);
  });
  r.get("/:id/", async (req, res) => {
    res.json(webhookOut(await find(req)));
  });

  r.post("/", async (req, res) => {
    const data = parse(webhookBody, req.body);
    await safeUrl(data.url);
    const hook = await inTransaction(async (unit) => {
      const h = await unit.tx.webhook.create({
        data: { workspaceId: ws(req).id, url: data.url, events: data.events, isActive: data.is_active, secret: generateSecret() },
      });
      await record(unit, req, "webhook.created", entity.webhook(h), { url: h.url }, { emitEvent: false });
      return h;
    });
    res.status(201).json(webhookOut(hook));
  });

  const update = async (req: Request, res: Response) => {
    const h = await find(req);
    const data = parse(webhookPatch, req.body);
    await safeUrl(data.url);
    const changes = diff(
      { url: h.url, events: JSON.stringify(h.events), is_active: h.isActive },
      { url: data.url, events: data.events && JSON.stringify(data.events), is_active: data.is_active },
    );
    if (changes.events) changes.events = [JSON.parse(String(changes.events[0])), JSON.parse(String(changes.events[1]))];
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.webhook.update({ where: { id: h.id }, data: { url: data.url, events: data.events, isActive: data.is_active } });
      if (Object.keys(changes).length) await record(unit, req, "webhook.updated", entity.webhook(u), changes, { emitEvent: false });
      return u;
    });
    res.json(webhookOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);

  r.delete("/:id/", async (req, res) => {
    const h = await find(req);
    await inTransaction(async (unit) => {
      await record(unit, req, "webhook.deleted", entity.webhook(h), { url: h.url }, { emitEvent: false });
      await unit.tx.webhook.delete({ where: { id: h.id } });
    });
    res.status(204).end();
  });

  r.post("/:id/ping/", async (req, res) => {
    const h = await find(req);
    const d = await inTransaction((unit) => queueDelivery(unit, h, "ping", { message: "Hello from TaskFlow" }));
    res.json({ queued: 1, delivery: d.id });
  });

  // A new signing secret, effective for every delivery from now on (e.g. after the old one leaked).
  r.post("/:id/rotate_secret/", async (req, res) => {
    const h = await find(req);
    const updated = await inTransaction(async (unit) => {
      const u = await unit.tx.webhook.update({ where: { id: h.id }, data: { secret: generateSecret() } });
      // The secret itself isn't logged.
      await record(unit, req, "webhook.secret_rotated", entity.webhook(u), {}, { emitEvent: false });
      return u;
    });
    res.json(webhookOut(updated));
  });

  r.get("/:id/deliveries/", async (req, res) => {
    const h = await find(req);
    const rows = await prisma.webhookDelivery.findMany({
      where: { workspaceId: ws(req).id, webhookId: h.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
    });
    res.json(rows.map(deliveryOut));
  });

  // {delivery}: send that delivery's event again, as a new delivery with the same payload.
  r.post("/:id/redeliver/", async (req, res) => {
    const h = await find(req);
    const raw = String(req.body?.delivery ?? "");
    const original = /^\d+$/.test(raw)
      ? await prisma.webhookDelivery.findFirst({ where: { id: Number(raw), workspaceId: ws(req).id, webhookId: h.id } })
      : null;
    if (!original) throw badRequest({ delivery: "Choose a delivery of this webhook." });
    const payload = original.payload as unknown as Payload;
    const d = await inTransaction((unit) => queueDelivery(unit, h, original.event, payload.data, payload));
    res.status(202).json({ queued: 1, delivery: d.id });
  });
  return r;
}

// ── Notifications (each person's own; every role may mark theirs read) ────────────────────────────────────────

type NoteRow = Notification & { issue: { projectId: number; number: number; project: { key: string } } | null };
const noteOut = (n: NoteRow) => ({
  id: n.id,
  verb: n.verb,
  message: n.message,
  issue: n.issueId,
  issue_key: n.issue ? `${n.issue.project.key}-${n.issue.number}` : null,
  project: n.issue?.projectId ?? null,
  read: n.read,
  created_at: iso(n.createdAt),
});
const noteInclude = { issue: { select: { projectId: true, number: true, project: { select: { key: true } } } } } as const;

export function notificationsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);
  const mine = (req: Request) => ({ workspaceId: ws(req).id, userId: currentUser(req).id });

  r.get("/", (req, res) => {
    const read = queryBool(req, "read");
    return sendPage(req, res, prisma.notification, { ...mine(req), ...(read !== undefined && { read }) },
      [{ createdAt: "desc" }, { id: "desc" }], noteOut, noteInclude);
  });

  r.get("/unread_count/", async (req, res) => {
    res.json({ count: await prisma.notification.count({ where: { ...mine(req), read: false } }) });
  });

  r.post("/mark_all_read/", async (req, res) => {
    const { count } = await prisma.notification.updateMany({ where: { ...mine(req), read: false }, data: { read: true } });
    res.json({ updated: count });
  });

  const update = async (req: Request, res: Response) => {
    const n = await own(prisma.notification.findFirst({ where: { id: routeId(req), ...mine(req) } }));
    const data = parse(z.object({ read: z.boolean().optional() }), req.body);
    const updated = await prisma.notification.update({ where: { id: n.id }, data, include: noteInclude });
    res.json(noteOut(updated));
  };
  r.patch("/:id/", update);
  r.put("/:id/", update);
  return r;
}

// ── Reports (members read; admins queue one on demand) ────────────────────────────────────────────────────────

const reportOut = (rep: Report) => ({ id: rep.id, kind: rep.kind, data: rep.data, created_at: iso(rep.createdAt) });

export function reportsRouter(): Router {
  const r = Router();
  r.use(useWorkspace);

  r.post("/generate/", async (req, res) => {
    need(req, "admin");
    const taskId = await enqueue("generate_weekly_report", { workspaceId: ws(req).id });
    res.status(202).json({ task_id: taskId, status: "queued" });
  });

  r.use((req, _res, next) => (need(req, "member"), next()));
  r.get("/", (req, res) =>
    sendPage(req, res, prisma.report, { workspaceId: ws(req).id }, [{ createdAt: "desc" }, { id: "desc" }], reportOut),
  );
  r.get("/:id/", async (req, res) => {
    res.json(reportOut(await own(prisma.report.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id } }))));
  });
  return r;
}
