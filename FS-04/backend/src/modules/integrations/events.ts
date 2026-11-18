import { randomBytes } from "node:crypto";
import type { Webhook } from "../../generated/prisma/client.js";
import type { Unit } from "../../lib/db.js";
import { enqueue } from "../../jobs/queue.js";

// Every event the API can send to webhooks (each comes from an audit entry written with emitEvent on).
// A test checks this list against what the app actually emits, so a new event can't go unlisted.
export const WEBHOOK_EVENTS = [
  "issue.created", "issue.updated", "issue.moved", "issue.deleted",
  "comment.created", "comment.updated", "comment.deleted",
  "attachment.created", "attachment.deleted",
  "project.created", "project.updated", "project.deleted",
  "board.created", "board.updated", "board.deleted",
  "sprint.created", "sprint.updated", "sprint.deleted", "sprint.started", "sprint.completed",
  "workflow.created", "workflow.updated", "workflow.deleted",
  "status.created", "status.updated", "status.deleted",
  "transition.created", "transition.deleted",
  "member.added", "member.role_changed", "member.removed", "member.left",
] as const;

export const generateSecret = (): string => "whsec_" + randomBytes(24).toString("hex");

export const subscribedTo = (hook: Pick<Webhook, "isActive" | "events">, event: string): boolean => {
  const events = Array.isArray(hook.events) ? (hook.events as string[]) : [];
  return hook.isActive && (events.length === 0 || events.includes(event));
};

export interface Payload {
  event: string;
  workspace: string;
  occurred_at: string;
  data: unknown;
}

// Save a delivery row and send it from the worker once the transaction commits.
// `payload` reuses an earlier delivery's exact body (a redelivery keeps the original occurred_at).
export async function queueDelivery(unit: Unit, hook: Webhook, event: string, data: unknown, payload?: Payload) {
  let body = payload;
  if (!body) {
    const ws = await unit.tx.workspace.findUniqueOrThrow({ where: { id: hook.workspaceId }, select: { slug: true } });
    body = { event, workspace: ws.slug, occurred_at: new Date().toISOString(), data };
  }
  const delivery = await unit.tx.webhookDelivery.create({
    data: { workspaceId: hook.workspaceId, webhookId: hook.id, event, payload: body as object },
  });
  unit.after(() => enqueue("deliver_webhook", { deliveryId: delivery.id }));
  return delivery;
}

// Fan an event out to every active webhook subscribed to it.
export async function emit(unit: Unit, workspaceId: number, event: string, data: unknown) {
  const hooks = await unit.tx.webhook.findMany({ where: { workspaceId, isActive: true } });
  const out = [];
  for (const hook of hooks.filter((h) => subscribedTo(h, event))) out.push(await queueDelivery(unit, hook, event, data));
  return out;
}
