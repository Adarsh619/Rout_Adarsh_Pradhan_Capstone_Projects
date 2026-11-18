import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import { inTransaction, prisma } from "../../lib/db.js";
import { badRequest, invalid, notFound } from "../../lib/errors.js";
import { iso } from "../../lib/http.js";
import { parse } from "../../lib/validate.js";
import { entity } from "../audit/entities.js";
import { record } from "../audit/service.js";
import { currentUser } from "../auth/middleware.js";
import { hasRole, need, useWorkspace, ws } from "../tenancy/context.js";
import { subscriptionOf, usage } from "./limits.js";
import { deliver, simulateEvents } from "./mock.js";
import { effectivePlan, PLANS } from "./plans.js";
import { billingMode, createCheckoutSession, createPortalSession, processWebhook } from "./stripe.js";

const checkoutBody = z.object({ plan: z.enum(["pro", "business"]) });
const mockBody = z.object({ action: z.enum(["subscribe", "cancel"]).default("subscribe"), plan: z.enum(["pro", "business"]).optional() });

// Called by Stripe (no login). 400 for a bad signature; a repeated event answers status "duplicate".
export async function stripeWebhook(req: Request, res: Response) {
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const [status, out] = await processWebhook(body, req.get("stripe-signature") ?? "");
  res.status(status).json(out);
}

export function billingRouter(): Router {
  const r = Router();
  r.use(useWorkspace);

  // The current plan, its limits and the workspace's usage.
  r.get("/", async (req, res) => {
    const sub = await subscriptionOf(prisma, ws(req).id);
    const mode = billingMode();
    const plan = effectivePlan(sub);
    res.json({
      plan: sub.plan,
      effective_plan: plan,
      status: sub.status,
      current_period_end: iso(sub.currentPeriodEnd),
      cancel_at_period_end: sub.cancelAtPeriodEnd,
      limits: PLANS[plan].limits,
      usage: await usage(prisma, ws(req).id),
      plans: PLANS,
      mode,
      stripe_enabled: mode !== "disabled",
      has_subscription: Boolean(sub.stripeSubscriptionId),
      can_manage: hasRole(req.membership, "owner"),
    });
  });

  // Start a subscription (owner). Refused if the workspace already has one: plans change through the portal.
  r.post("/checkout/", async (req, res) => {
    need(req, "owner");
    const { plan } = parse(checkoutBody, req.body);
    res.json({ url: await createCheckoutSession(ws(req), plan, currentUser(req).email) });
  });

  // Stripe's Customer Portal, to change plan or cancel (owner).
  r.post("/portal/", async (req, res) => {
    need(req, "owner");
    res.json({ url: await createPortalSession(ws(req)) });
  });

  // STRIPE_MOCK only: act as Stripe after the simulated checkout or portal page, by sending signed Stripe events
  // through the real webhook handler.
  r.post("/mock/complete/", async (req, res) => {
    need(req, "owner");
    if (!config.stripe.mock) throw notFound("Mock billing is disabled.");
    const data = parse(mockBody, req.body);
    const sub = await subscriptionOf(prisma, ws(req).id);
    let action: "subscribe" | "change" | "cancel" = data.action;
    if (action === "subscribe") {
      if (!data.plan) throw badRequest({ plan: "Choose a plan." });
      if (sub.stripeSubscriptionId) action = "change";
    } else if (!sub.stripeSubscriptionId) {
      throw invalid("There is no subscription to cancel.");
    }
    const results = await deliver(simulateEvents(sub, action, data.plan));
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // The owner's click; the plan change itself is also audited as "billing.stripe_update" by the webhook handler.
    await inTransaction((unit) =>
      record(unit, req, `billing.${action}`, entity.subscription(after, ws(req).name), { plan: [sub.plan, after.plan] }, { emitEvent: false }),
    );
    res.json({ plan: after.plan, status: after.status, webhooks: results.map(([, body]) => body) });
  });
  return r;
}
