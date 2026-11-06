import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import {
  createPaymentProvider,
  PaymentProviderError,
  RazorpayPaymentProvider,
  webhookSignatureValid,
} from "../src/modules/payments/payment-provider.js";
import { MockPayoutProvider } from "../src/modules/payments/payout-provider.js";
import { ledgerKey } from "../src/modules/payments/ledger.model.js";

const KEY_ID = "rzp_test_unit0000000000";
const SECRET = "unit-test-key-secret";
const hmac = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

type Call = { method: string; url: string; body?: unknown; auth?: string };

// A fake Razorpay API: answers by "METHOD /path" and records every call.
function fakeRazorpay(routes: Record<string, (body: unknown) => { status?: number; json: unknown }>) {
  const calls: Call[] = [];
  const http = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: url.pathname + url.search, body, auth: (init?.headers as Record<string, string>)?.Authorization });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: { description: "not found" } }), { status: 404 });
    const r = route(body);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { http, calls, provider: new RazorpayPaymentProvider(KEY_ID, SECRET, http, "https://api.test/v1") };
}

describe("Razorpay driver", () => {
  it("creates an order in paise and INR with basic auth", async () => {
    const { provider, calls } = fakeRazorpay({ "POST /v1/orders": () => ({ json: { id: "order_abc" } }) });
    expect(await provider.createOrder({ amount: 2_059_800, receipt: "SS-2026-000001" })).toEqual({ providerOrderId: "order_abc" });
    expect(calls[0]!.body).toMatchObject({ amount: 2_059_800, currency: "INR", receipt: "SS-2026-000001" });
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from(`${KEY_ID}:${SECRET}`).toString("base64")}`);
    expect(provider.publicConfig()).toEqual({ keyId: KEY_ID });
  });

  it("checks the popup's signature with the key secret", () => {
    const { provider } = fakeRazorpay({});
    const signature = hmac(SECRET, "order_abc|pay_xyz");
    expect(provider.verifyPayment({ providerOrderId: "order_abc", providerPaymentId: "pay_xyz", signature })).toBe(true);
    expect(provider.verifyPayment({ providerOrderId: "order_abc", providerPaymentId: "pay_other", signature })).toBe(false);
  });

  it("captures an authorised payment, accepts a captured one, and refuses a mismatch or a failure", async () => {
    const payment = (status: string, overrides = {}) => () => ({ json: { id: "pay_xyz", order_id: "order_abc", amount: 1000, status, ...overrides } });
    const authorised = fakeRazorpay({ "GET /v1/payments/pay_xyz": payment("authorized"), "POST /v1/payments/pay_xyz/capture": () => ({ json: {} }) });
    await authorised.provider.ensureCaptured({ providerOrderId: "order_abc", providerPaymentId: "pay_xyz", amount: 1000 });
    expect(authorised.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /v1/payments/pay_xyz", "POST /v1/payments/pay_xyz/capture"]);

    const captured = fakeRazorpay({ "GET /v1/payments/pay_xyz": payment("captured") });
    await captured.provider.ensureCaptured({ providerOrderId: "order_abc", providerPaymentId: "pay_xyz", amount: 1000 });
    expect(captured.calls).toHaveLength(1);

    const wrongAmount = fakeRazorpay({ "GET /v1/payments/pay_xyz": payment("captured", { amount: 1 }) });
    await expect(wrongAmount.provider.ensureCaptured({ providerOrderId: "order_abc", providerPaymentId: "pay_xyz", amount: 1000 })).rejects.toMatchObject({ code: "invalid_signature" });

    const failed = fakeRazorpay({ "GET /v1/payments/pay_xyz": payment("failed") });
    await expect(failed.provider.ensureCaptured({ providerOrderId: "order_abc", providerPaymentId: "pay_xyz", amount: 1000 })).rejects.toMatchObject({ code: "payment_not_completed" });
  });

  it("never refunds twice for the same key", async () => {
    const existing = fakeRazorpay({
      "GET /v1/payments/pay_xyz/refunds": () => ({ json: { items: [{ id: "rfnd_old", status: "processed", notes: { key: "refund-part1" } }] } }),
    });
    expect(await existing.provider.refund({ providerPaymentId: "pay_xyz", amount: 500, key: "refund-part1" })).toEqual({ refundId: "rfnd_old", status: "processed" });
    expect(existing.calls.some((c) => c.method === "POST")).toBe(false);

    const fresh = fakeRazorpay({
      "GET /v1/payments/pay_xyz/refunds": () => ({ json: { items: [{ id: "rfnd_other", status: "processed", notes: [] }] } }),
      "POST /v1/payments/pay_xyz/refund": () => ({ json: { id: "rfnd_new", status: "pending" } }),
    });
    expect(await fresh.provider.refund({ providerPaymentId: "pay_xyz", amount: 500, key: "refund-part2" })).toEqual({ refundId: "rfnd_new", status: "pending" });
    expect(fresh.calls.at(-1)!.body).toEqual({ amount: 500, speed: "normal", notes: { key: "refund-part2" } });
  });

  it("turns Razorpay errors into PaymentProviderError with their message", async () => {
    const { provider } = fakeRazorpay({
      "POST /v1/orders": () => ({ status: 401, json: { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } } }),
    });
    const err = await provider.createOrder({ amount: 100, receipt: "r" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaymentProviderError);
    expect(err).toMatchObject({ message: "Authentication failed", httpStatus: 401, code: "BAD_REQUEST_ERROR" });
  });
});

describe("webhook signatures", () => {
  it("accepts only the exact body signed with the webhook secret", () => {
    const body = Buffer.from('{"event":"payment.captured"}');
    const signature = hmac("whsec", body.toString());
    expect(webhookSignatureValid("whsec", body, signature)).toBe(true);
    expect(webhookSignatureValid("whsec", Buffer.from('{"event": "payment.captured"}'), signature)).toBe(false);
    expect(webhookSignatureValid("other", body, signature)).toBe(false);
  });
});

describe("settings", () => {
  it("refuses live Razorpay keys and Razorpay without keys", () => {
    expect(() => loadEnv({ RAZORPAY_KEY_ID: "rzp_live_abcdefghijklmn" })).toThrow(/test key/);
    expect(() => loadEnv({ PAYMENT_PROVIDER: "razorpay" })).toThrow(/RAZORPAY_KEY_ID/);
    expect(loadEnv({ PAYMENT_PROVIDER: "razorpay", RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: SECRET }).RAZORPAY_KEY_ID).toBe(KEY_ID);
    // Empty values mean "not set", e.g. an empty RAZORPAY_WEBHOOK_SECRET= line in .env.
    expect(loadEnv({ RAZORPAY_WEBHOOK_SECRET: "" }).RAZORPAY_WEBHOOK_SECRET).toBeUndefined();
    expect(() => createPaymentProvider("razorpay", "x", {})).toThrow(/RAZORPAY_KEY_ID/);
  });
});

describe("simulated payouts and the ledger", () => {
  it("gives the same reference for the same payout key, and keeps one ledger entry per part and type", async () => {
    const payouts = new MockPayoutProvider();
    const a = await payouts.pay({ beneficiaryRef: "bene", amount: 100, key: "payout-1" });
    expect(await payouts.pay({ beneficiaryRef: "bene", amount: 100, key: "payout-1" })).toEqual(a);
    expect(ledgerKey({ type: "vendor_hold", orderId: "o1", subOrderId: "s1" })).toBe("vendor_hold:s1");
    expect(ledgerKey({ type: "payment", orderId: "o1" })).toBe("payment:o1");
  });
});
