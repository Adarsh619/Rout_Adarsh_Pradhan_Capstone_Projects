import Stripe from "stripe";
import type { Subscription } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { isUniqueViolation, lockRow, prisma, type Tx, type Unit } from "../../lib/db.js";
import { badRequest, serviceUnavailable } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { entity } from "../audit/entities.js";
import { recordSystem } from "../audit/service.js";
import { planForPrice, priceId } from "./plans.js";

// A thin wrapper around Stripe Billing (test mode, or Stripe's official stripe-mock server).
//
// Stripe sends webhooks at least once and in no guaranteed order, so the handler:
// - records an event as processed in the same transaction that applies it (a failure rolls both back, and
//   Stripe's retry is applied rather than skipped as a duplicate);
// - ignores events about a subscription other than the workspace's current one, and events older than the last
//   one applied (a late "deleted" for an old subscription can't downgrade a paying workspace);
// - writes a "billing.stripe_update" audit entry whenever an event changes the plan or status.

// A workspace in one of these states already pays (or is about to): a second checkout would bill twice.
const LIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
const STATUSES = new Set(["active", "trialing", "past_due", "canceled", "incomplete"]);

export const NOT_CONFIGURED = "Stripe is not configured. Set STRIPE_SECRET_KEY and price IDs in .env (test mode keys).";

let client: Stripe | undefined;
let clientKey = "";
// Tests put a stand-in Stripe client here (live mode without a Stripe account).
export const fakes: { client: Stripe | null } = { client: null };

export function stripeClient(): Stripe {
  const key = config.stripe.secretKey;
  if (!key) throw serviceUnavailable(NOT_CONFIGURED);
  if (fakes.client) return fakes.client;
  if (!client || clientKey !== key) {
    const base = new URL(config.stripe.apiBase);
    client = new Stripe(key, {
      maxNetworkRetries: 1,
      ...(config.stripe.mock && {
        host: base.hostname,
        port: Number(base.port || (base.protocol === "https:" ? 443 : 80)),
        protocol: base.protocol.replace(":", "") as "http" | "https",
      }),
    });
    clientKey = key;
  }
  return client;
}

export function billingMode(): "mock" | "live" | "disabled" {
  if (config.stripe.mock) return "mock";
  return config.stripe.secretKey ? "live" : "disabled";
}

async function ensureCustomer(tx: Tx, sub: Subscription, email: string, workspaceName: string): Promise<string> {
  if (sub.stripeCustomerId) return sub.stripeCustomerId;
  const customer = await stripeClient().customers.create({
    email,
    name: workspaceName,
    metadata: { workspace_id: String(sub.workspaceId) },
  });
  await tx.subscription.update({ where: { id: sub.id }, data: { stripeCustomerId: customer.id } });
  return customer.id;
}

export async function createCheckoutSession(workspace: { id: number; slug: string; name: string }, plan: string, email: string) {
  return prisma.$transaction(
    async (tx) => {
      // Locked so two quick Upgrade clicks can't create two Stripe customers.
      const existing = await tx.subscription.upsert({ where: { workspaceId: workspace.id }, update: {}, create: { workspaceId: workspace.id } });
      await lockRow(tx, "subscriptions", existing.id);
      const sub = await tx.subscription.findUniqueOrThrow({ where: { id: existing.id } });
      if (sub.stripeSubscriptionId && LIVE_STATUSES.has(sub.status)) {
        throw badRequest("This workspace already has a subscription. Use Manage subscription to change plans.");
      }
      const price = priceId(plan);
      if (!price) throw serviceUnavailable(`No Stripe price configured for plan '${plan}'.`);
      const customer = await ensureCustomer(tx, sub, email, workspace.name);
      const base = `${config.FRONTEND_URL}/w/${workspace.slug}/billing`;
      const session = await stripeClient().checkout.sessions.create({
        mode: "subscription",
        customer,
        line_items: [{ price, quantity: 1 }],
        success_url: `${base}?checkout=success`,
        cancel_url: `${base}?checkout=cancel`,
        client_reference_id: String(workspace.id),
        subscription_data: { metadata: { workspace_id: String(workspace.id) } },
        metadata: { workspace_id: String(workspace.id), plan },
      });
      // stripe-mock has no hosted payment page; the app shows its own simulated checkout page instead.
      if (config.stripe.mock) return `/w/${workspace.slug}/billing/checkout?plan=${plan}&session=${session.id}`;
      return session.url ?? "";
    },
    { timeout: 30_000 },
  );
}

export async function createPortalSession(workspace: { id: number; slug: string }) {
  const sub = await prisma.subscription.findUnique({ where: { workspaceId: workspace.id } });
  if (!sub?.stripeCustomerId) throw serviceUnavailable("This workspace has no Stripe customer yet — subscribe first.");
  const session = await stripeClient().billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: `${config.FRONTEND_URL}/w/${workspace.slug}/billing`,
  });
  if (config.stripe.mock) return `/w/${workspace.slug}/billing/checkout?manage=1`;
  return session.url;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function auditChange(unit: Unit, sub: Subscription, before: { plan: string; status: string }) {
  const changes: Record<string, [string, string]> = {};
  if (before.plan !== sub.plan) changes.plan = [before.plan, sub.plan];
  if (before.status !== sub.status) changes.status = [before.status, sub.status];
  if (Object.keys(changes).length) {
    const ws = await unit.tx.workspace.findUniqueOrThrow({ where: { id: sub.workspaceId } });
    await recordSystem(unit, sub.workspaceId, "billing.stripe_update", entity.subscription(sub, ws.name), changes);
  }
}

// Apply a Stripe Subscription object to our Subscription row (or ignore it if it is stale).
export async function syncSubscription(unit: Unit, stripeSub: Obj, eventCreated?: number) {
  const { tx } = unit;
  const metadata = (stripeSub.metadata ?? {}) as Obj;
  const wsId = Number(metadata.workspace_id);
  let sub = Number.isSafeInteger(wsId) && wsId > 0 ? await tx.subscription.findUnique({ where: { workspaceId: wsId } }) : null;
  if (!sub && str(stripeSub.customer)) sub = await tx.subscription.findFirst({ where: { stripeCustomerId: str(stripeSub.customer) } });
  if (!sub) return null;
  await lockRow(tx, "subscriptions", sub.id);
  sub = await tx.subscription.findUniqueOrThrow({ where: { id: sub.id } });

  const incoming = str(stripeSub.id);
  if (sub.stripeSubscriptionId && incoming && incoming !== sub.stripeSubscriptionId) {
    logger.info({ incoming, workspace: sub.workspaceId }, "ignoring event for another subscription");
    return sub;
  }
  if (eventCreated && sub.stripeEventCreated && BigInt(eventCreated) < sub.stripeEventCreated) {
    logger.info({ eventCreated }, "ignoring out-of-order Stripe event");
    return sub;
  }
  const before = { plan: sub.plan, status: sub.status };
  const items = (((stripeSub.items ?? {}) as Obj).data ?? []) as Obj[];
  const first = items[0];
  const price = first ? str((first.price as Obj | undefined)?.id) : null;
  const periodEnd = (stripeSub.current_period_end ?? first?.current_period_end) as number | undefined;
  const status = str(stripeSub.status) || "active";
  const canceled = status === "canceled";
  const updated = await tx.subscription.update({
    where: { id: sub.id },
    data: {
      stripeSubscriptionId: canceled ? "" : incoming,
      stripeCustomerId: str(stripeSub.customer) || sub.stripeCustomerId,
      status: canceled ? "active" : ((STATUSES.has(status) ? status : "incomplete") as Subscription["status"]),
      plan: canceled ? "free" : (planForPrice(price) ?? sub.plan),
      currentPeriodEnd: canceled || !periodEnd ? null : new Date(periodEnd * 1000),
      cancelAtPeriodEnd: canceled ? false : Boolean(stripeSub.cancel_at_period_end),
      ...(eventCreated && { stripeEventCreated: BigInt(eventCreated) }),
    },
  });
  await auditChange(unit, updated, before);
  return updated;
}

// Indirection so a test can make applying an event fail (the event must then not be marked processed).
export const handlers = { syncSubscription };

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);

async function apply(unit: Unit, event: Obj) {
  const obj = ((event.data ?? {}) as Obj).object as Obj;
  const type = str(event.type);
  if (SUBSCRIPTION_EVENTS.has(type)) {
    const sub = await handlers.syncSubscription(unit, obj, event.created as number | undefined);
    if (sub) logger.info({ workspace: sub.workspaceId, plan: sub.plan, status: sub.status }, "subscription synced");
  } else if (type === "checkout.session.completed" && str(obj.subscription)) {
    const metadata = (obj.metadata ?? {}) as Obj;
    const wsId = Number(metadata.workspace_id ?? obj.client_reference_id);
    if (!Number.isSafeInteger(wsId)) return;
    // Never replace a different subscription the workspace already has.
    await unit.tx.subscription.updateMany({
      where: { workspaceId: wsId, stripeSubscriptionId: { in: ["", str(obj.subscription)] } },
      data: { stripeCustomerId: str(obj.customer), stripeSubscriptionId: str(obj.subscription) },
    });
  } else if (type === "invoice.payment_failed") {
    const rows = await unit.tx.subscription.findMany({
      where: {
        stripeCustomerId: str(obj.customer) || "\u0000",
        // Only the current subscription's invoices count.
        ...(str(obj.subscription) && { stripeSubscriptionId: str(obj.subscription) }),
      },
    });
    for (const sub of rows) {
      await lockRow(unit.tx, "subscriptions", sub.id);
      const updated = await unit.tx.subscription.update({ where: { id: sub.id }, data: { status: "past_due" } });
      await auditChange(unit, updated, sub);
    }
  }
}

// Verify a Stripe webhook and apply it; returns [httpStatus, body]. Idempotent per event id.
// If applying the event fails, nothing is saved (not even the "processed" mark) and the error becomes a 500,
// so Stripe retries the delivery later.
export async function processWebhook(payload: Buffer | string, signature: string): Promise<[number, Obj]> {
  try {
    stripeClientForWebhooks().webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "invalid Stripe webhook");
    return [400, { detail: "invalid signature" }];
  }
  const event = JSON.parse(payload.toString()) as Obj;
  try {
    await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({ data: { eventId: str(event.id), type: str(event.type) } });
      await apply({ tx, after: () => undefined }, event);
    });
  } catch (err) {
    if (isUniqueViolation(err)) return [200, { status: "duplicate" }];
    throw err;
  }
  return [200, { status: "ok" }];
}

// Verifying signatures needs no API key, so it works even when billing is switched off.
let verifier: Stripe | undefined;
function stripeClientForWebhooks(): Stripe {
  verifier ??= new Stripe("sk_test_signature_check_only");
  return verifier;
}

export { stripeClientForWebhooks };
