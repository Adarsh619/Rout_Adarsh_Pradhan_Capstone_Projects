import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { fakes, handlers } from "../src/modules/billing/stripe.js";
import { addMember, anon, clientFor, prisma, world } from "./helpers.js";

// Plans, limits and Stripe Billing (v1: test_billing, test_billing_events). Mock mode talks to the real stripe-mock
// server (docker compose up -d stripe-mock); live mode uses a stand-in Stripe client.

const realSync = handlers.syncSubscription;
afterEach(() => {
  fakes.client = null;
  handlers.syncSubscription = realSync;
});

// Real Stripe mode (not mock): webhooks signed with a known test secret, one Pro price.
function stripeLive() {
  config.stripe = { ...config.stripe, mock: false, secretKey: "sk_test_x", webhookSecret: "whsec_test", pricePro: "price_pro", priceBusiness: "price_business" };
}

interface Created { customers: object[]; sessions: Array<{ line_items: unknown }> }
function fakeStripe(sessionUrl = "https://checkout.stripe.test/s"): Created {
  const created: Created = { customers: [], sessions: [] };
  fakes.client = {
    customers: { create: async (args: object) => (created.customers.push(args), { id: "cus_1" }) },
    checkout: { sessions: { create: async (args: { line_items: unknown }) => (created.sessions.push(args), { id: "cs_1", url: sessionUrl }) } },
    billingPortal: { sessions: { create: async () => ({ url: "https://portal.stripe.test/p" }) } },
  } as unknown as Stripe;
  return created;
}

const signer = new Stripe("sk_test_signing_only");
async function postSigned(event: object, secret = "whsec_test", signature?: string) {
  const payload = JSON.stringify(event);
  const sig = signature ?? signer.webhooks.generateTestHeaderString({ payload, secret });
  return (await anon()).post("/api/billing/stripe-webhook/").set("Content-Type", "application/json").set("Stripe-Signature", sig).send(payload);
}

function subEvent(id: string, workspaceId: number, o: { subId?: string; created?: number; status?: string; price?: string; type?: string } = {}) {
  return {
    id, object: "event", type: o.type ?? "customer.subscription.updated", created: o.created ?? 100,
    data: { object: {
      id: o.subId ?? "sub_1", customer: "cus_1", status: o.status ?? "active", cancel_at_period_end: false,
      current_period_end: 1893456000, metadata: { workspace_id: String(workspaceId) },
      items: { data: [{ price: { id: o.price ?? "price_pro" } }] },
    } },
  };
}

const subOf = (workspaceId: number) => prisma.subscription.findUniqueOrThrow({ where: { workspaceId } });
const setSub = (workspaceId: number, data: object) => prisma.subscription.update({ where: { workspaceId }, data });

describe("plans and limits", () => {
  it("the free plan's project limit answers 402", async () => {
    const { api } = await world();
    for (let i = 0; i < 2; i++) expect((await api.post("/api/projects/", { key: `P${i}`, name: `P${i}` })).status).toBe(201);
    const r = await api.post("/api/projects/", { key: "P3", name: "P3" });
    expect(r.status).toBe(402);
    expect(r.body.detail).toContain("Upgrade");
  });

  it("parallel creates can't squeeze past the limit", async () => {
    const { api } = await world();
    const codes = (await Promise.all([0, 1, 2, 3].map((i) => api.post("/api/projects/", { key: `R${i}`, name: `R${i}` })))).map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(2);
    expect(await prisma.project.count()).toBe(2);
  });

  it("an upgraded plan raises the limit", async () => {
    const { api, workspace } = await world();
    await setSub(workspace.id, { plan: "pro" });
    for (let i = 0; i < 3; i++) expect((await api.post("/api/projects/", { key: `P${i}`, name: `P${i}` })).status).toBe(201);
  });

  it("past due falls back to the free limits", async () => {
    const { api, workspace } = await world();
    await setSub(workspace.id, { plan: "pro", status: "past_due" });
    const r = await api.get("/api/billing/");
    expect(r.body.effective_plan).toBe("free");
    expect(r.body.limits.projects).toBe(2);
  });

  it("the billing overview", async () => {
    const { api } = await world();
    const r = await api.get("/api/billing/");
    expect(r.body).toMatchObject({ plan: "free", mode: "mock", can_manage: true, has_subscription: false });
    expect(r.body.usage.members).toBe(1);
    expect(r.body.plans.business.limits.projects).toBeNull();
  });
});

describe("checkout", () => {
  it("without Stripe configured answers 503", async () => {
    const { api } = await world();
    config.stripe = { ...config.stripe, mock: false, secretKey: "" };
    expect((await api.post("/api/billing/checkout/", { plan: "pro" })).status).toBe(503);
  });

  it("creates a Stripe customer and checkout session (live mode)", async () => {
    const { api, workspace } = await world();
    stripeLive();
    const created = fakeStripe();
    const r = await api.post("/api/billing/checkout/", { plan: "pro" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.url.startsWith("https://checkout")).toBe(true);
    expect(created.sessions[0]!.line_items).toEqual([{ price: "price_pro", quantity: 1 }]);
    expect((await subOf(workspace.id)).stripeCustomerId).toBe("cus_1");
  });

  it("only the owner can check out", async () => {
    const { workspace } = await world();
    const admin = await addMember(workspace, "a@acme.test", "admin");
    expect((await (await clientFor(admin, workspace)).post("/api/billing/checkout/", { plan: "pro" })).status).toBe(403);
  });

  it("is refused while a subscription is live, and works again once it has ended", async () => {
    const { api, workspace } = await world();
    stripeLive();
    const created = fakeStripe("https://checkout.test/s");
    await setSub(workspace.id, { plan: "pro", stripeSubscriptionId: "sub_1", stripeCustomerId: "cus_1" });
    const r = await api.post("/api/billing/checkout/", { plan: "business" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain("Manage subscription");
    expect(created.sessions).toHaveLength(0);
    await setSub(workspace.id, { plan: "free", stripeSubscriptionId: "" });
    expect((await api.post("/api/billing/checkout/", { plan: "pro" })).status).toBe(200);
  });

  it("against the real stripe-mock server (mock mode)", async () => {
    const { api, workspace } = await world();
    const r = await api.post("/api/billing/checkout/", { plan: "pro" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.url).toMatch(/^\/w\/acme\/billing\/checkout\?plan=pro&session=cs_/);
    expect((await subOf(workspace.id)).stripeCustomerId.startsWith("cus_")).toBe(true);
    expect((await api.post("/api/billing/portal/")).body.url).toBe("/w/acme/billing/checkout?manage=1");
  });
});

describe("Stripe webhooks", () => {
  it("sync a subscription, idempotently", async () => {
    const { workspace } = await world();
    stripeLive();
    const event = subEvent("evt_1", workspace.id);
    expect((await postSigned(event)).status).toBe(200);
    expect((await postSigned(event)).body.status).toBe("duplicate");
    const sub = await subOf(workspace.id);
    expect(sub.plan).toBe("pro");
    expect(sub.stripeSubscriptionId).toBe("sub_1");
    expect(sub.currentPeriodEnd!.getUTCFullYear()).toBe(2030);
    expect(await prisma.stripeEvent.count()).toBe(1);
  });

  it("a cancellation downgrades to free", async () => {
    const { workspace } = await world();
    stripeLive();
    await setSub(workspace.id, { plan: "pro" });
    await postSigned(subEvent("evt_2", workspace.id, { status: "canceled", type: "customer.subscription.deleted" }));
    const sub = await subOf(workspace.id);
    expect(sub.plan).toBe("free");
    expect(sub.currentPeriodEnd).toBeNull();
  });

  it("a failed payment marks the subscription past due", async () => {
    const { workspace } = await world();
    stripeLive();
    await setSub(workspace.id, { plan: "pro", stripeCustomerId: "cus_9" });
    await postSigned({ id: "evt_3", type: "invoice.payment_failed", data: { object: { customer: "cus_9" } } });
    expect((await subOf(workspace.id)).status).toBe("past_due");
  });

  it("rejects a bad signature or one made with the wrong secret", async () => {
    const { workspace } = await world();
    stripeLive();
    const event = subEvent("evt_4", workspace.id);
    expect((await postSigned(event, "whsec_test", "t=1,v1=bad")).status).toBe(400);
    expect((await postSigned(event, "whsec_attacker")).status).toBe(400);
    expect(await prisma.stripeEvent.count()).toBe(0);
  });

  it("a late delete of an old subscription doesn't downgrade", async () => {
    const { workspace } = await world();
    stripeLive();
    await postSigned(subEvent("evt_new", workspace.id, { subId: "sub_new", created: 200 }));
    expect((await subOf(workspace.id)).plan).toBe("pro");
    const r = await postSigned(subEvent("evt_old", workspace.id, { subId: "sub_old", created: 300, status: "canceled", type: "customer.subscription.deleted" }));
    expect(r.status).toBe(200);
    const sub = await subOf(workspace.id);
    expect(sub.plan).toBe("pro");
    expect(sub.stripeSubscriptionId).toBe("sub_new");
  });

  it("an older event arriving late is ignored", async () => {
    const { workspace } = await world();
    stripeLive();
    await postSigned(subEvent("evt_2", workspace.id, { created: 200, price: "price_business" }));
    await postSigned(subEvent("evt_1", workspace.id, { created: 100, price: "price_pro" }));
    const sub = await subOf(workspace.id);
    expect(sub.plan).toBe("business");
    expect(sub.stripeEventCreated).toBe(200n);
    expect(await prisma.stripeEvent.count()).toBe(2);
  });

  it("checkout.session.completed never replaces a different subscription", async () => {
    const { workspace } = await world();
    stripeLive();
    await postSigned(subEvent("evt_a", workspace.id, { subId: "sub_current" }));
    await postSigned({ id: "evt_b", type: "checkout.session.completed", created: 150, data: { object: {
      customer: "cus_1", subscription: "sub_other", metadata: { workspace_id: String(workspace.id) } } } });
    expect((await subOf(workspace.id)).stripeSubscriptionId).toBe("sub_current");
  });

  it("a payment failure of another subscription is ignored", async () => {
    const { workspace } = await world();
    stripeLive();
    await postSigned(subEvent("evt_a", workspace.id, { subId: "sub_current" }));
    const failed = (id: string, sub: string) => ({ id, type: "invoice.payment_failed", created: 150, data: { object: { customer: "cus_1", subscription: sub } } });
    await postSigned(failed("evt_f", "sub_old"));
    expect((await subOf(workspace.id)).status).toBe("active");
    await postSigned(failed("evt_g", "sub_current"));
    expect((await subOf(workspace.id)).status).toBe("past_due");
  });

  it("a failure while applying an event is retried by Stripe, not skipped", async () => {
    const { workspace } = await world();
    stripeLive();
    const event = subEvent("evt_boom", workspace.id);
    handlers.syncSubscription = async () => {
      throw new Error("database hiccup");
    };
    expect((await postSigned(event)).status).toBe(500);
    expect(await prisma.stripeEvent.count({ where: { eventId: "evt_boom" } })).toBe(0);
    expect((await subOf(workspace.id)).plan).toBe("free");
    handlers.syncSubscription = realSync;
    const r = await postSigned(event); // Stripe's retry
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect((await subOf(workspace.id)).plan).toBe("pro");
  });

  it("plan and status changes from Stripe are audited as the system", async () => {
    const { workspace } = await world();
    stripeLive();
    await postSigned(subEvent("evt_1", workspace.id, { created: 100 }));
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: "billing.stripe_update" } });
    expect(entry.changes).toEqual({ plan: ["free", "pro"] });
    expect(entry.actorId).toBeNull();
    expect(entry.actorEmail).toBe("");
    await postSigned(subEvent("evt_2", workspace.id, { created: 200 })); // same state: nothing to audit
    expect(await prisma.auditLog.count({ where: { action: "billing.stripe_update" } })).toBe(1);
    await postSigned({ id: "evt_3", type: "invoice.payment_failed", created: 300, data: { object: { customer: "cus_1", subscription: "sub_1" } } });
    const last = await prisma.auditLog.findFirstOrThrow({ where: { action: "billing.stripe_update" }, orderBy: { id: "desc" } });
    expect(last.changes).toEqual({ status: ["active", "past_due"] });
  });
});

describe("mock mode (stripe-mock + simulated checkout)", () => {
  it("subscribe, change and cancel go through signed webhooks", async () => {
    const { api, workspace } = await world();
    const r = await api.post("/api/billing/mock/complete/", { plan: "pro" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.plan).toBe("pro");
    expect(r.body.webhooks.map((w: { status: string }) => w.status)).toEqual(["ok", "ok"]);
    const sub = await subOf(workspace.id);
    expect(sub.stripeSubscriptionId.startsWith("sub_mock_")).toBe(true);
    expect(sub.currentPeriodEnd).toBeTruthy();
    for (let i = 0; i < 3; i++) expect((await api.post("/api/projects/", { key: `M${i}`, name: `M${i}` })).status).toBe(201);

    expect((await api.post("/api/billing/mock/complete/", { plan: "business" })).body.plan).toBe("business");
    expect((await api.post("/api/billing/mock/complete/", { action: "cancel" })).body.plan).toBe("free");
    expect(await prisma.stripeEvent.count()).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: { in: ["billing.subscribe", "billing.change", "billing.cancel"] } } })).toBe(3);
    const updates = await prisma.auditLog.findMany({ where: { action: "billing.stripe_update" }, orderBy: { id: "asc" } });
    expect(updates.map((e) => (e.changes as { plan: string[] }).plan)).toEqual([["free", "pro"], ["pro", "business"], ["business", "free"]]);
  });

  it("cancel without a subscription and subscribe without a plan are refused", async () => {
    const { api } = await world();
    expect((await api.post("/api/billing/mock/complete/", { action: "cancel" })).status).toBe(400);
    expect((await api.post("/api/billing/mock/complete/", {})).status).toBe(400);
  });

  it("is disabled outside mock mode", async () => {
    const { api } = await world();
    stripeLive();
    expect((await api.post("/api/billing/mock/complete/", { plan: "pro" })).status).toBe(404);
  });

  it("is owner-only", async () => {
    const { workspace } = await world();
    const admin = await addMember(workspace, "a2@acme.test", "admin");
    expect((await (await clientFor(admin, workspace)).post("/api/billing/mock/complete/", { plan: "pro" })).status).toBe(403);
  });
});
