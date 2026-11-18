import { randomUUID } from "node:crypto";
import type { Subscription } from "../../generated/prisma/client.js";
import { config } from "../../config.js";
import { priceId } from "./plans.js";
import { processWebhook, stripeClientForWebhooks } from "./stripe.js";

// Stripe mock mode (STRIPE_MOCK=true; Stripe accounts are invite-only in some countries, India included).
// - REAL: every Stripe SDK call (customer, checkout session, billing portal) goes to Stripe's official mock server
//   stripe-mock, which validates requests against Stripe's OpenAPI spec.
// - REAL: the webhook handler. Simulated events are signed with STRIPE_WEBHOOK_SECRET using Stripe's exact
//   signature scheme and go through the same verification and sync code that real Stripe events use.
// - SIMULATED: the hosted checkout page (a clearly labelled page in the React app) and the events Stripe would send.

type Obj = Record<string, unknown>;
const hex = (n: number) => randomUUID().replaceAll("-", "").slice(0, n);
const now = () => Math.floor(Date.now() / 1000);

const event = (type: string, object: Obj) => ({
  id: `evt_mock_${hex(20)}`,
  object: "event",
  type,
  created: now(),
  livemode: false,
  data: { object },
});

function subscription(sub: Subscription, plan: string, status = "active") {
  const periodEnd = now() + 30 * 24 * 3600;
  return {
    id: sub.stripeSubscriptionId || `sub_mock_${sub.workspaceId}_${hex(8)}`,
    object: "subscription",
    customer: sub.stripeCustomerId || `cus_mock_${sub.workspaceId}`,
    status,
    cancel_at_period_end: false,
    current_period_end: periodEnd,
    metadata: { workspace_id: String(sub.workspaceId) },
    items: { object: "list", data: [{ price: { id: priceId(plan) }, current_period_end: periodEnd }] },
  };
}

// The events Stripe would send for `action`.
export function simulateEvents(sub: Subscription, action: "subscribe" | "change" | "cancel", plan?: string) {
  if (action === "cancel") return [event("customer.subscription.deleted", subscription(sub, sub.plan, "canceled"))];
  const obj = subscription(sub, plan!);
  if (action === "change") return [event("customer.subscription.updated", obj)];
  const session = {
    id: `cs_mock_${hex(20)}`,
    object: "checkout.session",
    mode: "subscription",
    customer: obj.customer,
    subscription: obj.id,
    client_reference_id: String(sub.workspaceId),
    metadata: { workspace_id: String(sub.workspaceId), plan },
  };
  return [event("checkout.session.completed", session), event("customer.subscription.created", obj)];
}

// Sign each event like Stripe does and run it through the real webhook path.
export async function deliver(events: Obj[]) {
  const results = [];
  for (const ev of events) {
    const payload = JSON.stringify(ev);
    const header = stripeClientForWebhooks().webhooks.generateTestHeaderString({ payload, secret: config.stripe.webhookSecret });
    results.push(await processWebhook(payload, header));
  }
  return results;
}
