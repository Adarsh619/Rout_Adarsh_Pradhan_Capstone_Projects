import { createHmac } from "node:crypto";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { Category } from "../../src/modules/catalog/category.model.js";
import { Product } from "../../src/modules/catalog/product.model.js";
import { Counter, Order, SubOrder } from "../../src/modules/orders/order.model.js";
import { LedgerEntry, type LedgerType } from "../../src/modules/payments/ledger.model.js";
import { retryStuckMoney } from "../../src/modules/payments/money-jobs.js";
import { MockPaymentProvider, PaymentProviderError } from "../../src/modules/payments/payment-provider.js";
import { MockPayoutProvider } from "../../src/modules/payments/payout-provider.js";
import { WebhookEvent } from "../../src/modules/payments/webhook-event.model.js";
import { User } from "../../src/modules/users/user.model.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { approvedVendor, bearer, env, register, signInAdmin, startTestServices, wipe, withCsrf } from "./helpers.js";

// The mock provider, but tests can make its refunds come back "pending" like a slow Razorpay refund.
class TestPayments extends MockPaymentProvider {
  refundStatus: "processed" | "pending" = "processed";
  // Like a Razorpay test account that refuses refunds ("invalid request sent").
  refuseRefunds = false;
  override async refund(input: { providerPaymentId: string; amount: number; key: string }) {
    if (this.refuseRefunds) throw new PaymentProviderError("invalid request sent", 400, "BAD_REQUEST_ERROR");
    return { ...(await super.refund(input)), status: this.refundStatus };
  }
}
const payments = new TestPayments("payments-test-secret");

let app: Express;
let redis: Redis;

beforeAll(async () => {
  ({ app, redis } = await startTestServices({ payments }));
  await Promise.all([User.init(), Vendor.init(), Category.init(), Product.init(), Order.init(), SubOrder.init(), Counter.init(), LedgerEntry.init(), WebhookEvent.init()]);
});

beforeEach(async () => {
  payments.refundStatus = "processed";
  payments.refuseRefunds = false;
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);

async function shop() {
  const admin = await signInAdmin(app);
  const phones = await Category.create({ name: "Phones", slug: "phones", commissionRateBp: 1500 });
  const vikram = await approvedVendor(app, admin, "vikram@example.com", "Vikram Electronics");
  const meera = await approvedVendor(app, admin, "meera@example.com", "Meera Gadgets");
  const product = (vendorId: string, categoryId: Types.ObjectId, title: string, price: number) =>
    Product.create({ vendorId, categoryId, title, slug: title.toLowerCase().replace(/\W+/g, "-"), price, mrp: price, stock: 10, status: "active", images: [{ key: `products/${vendorId}/a.png`, alt: "" }] });
  const phone = await product(vikram.storeId, phones._id, "Galaxy Phone", 2_000_000);
  const cable = await product(meera.storeId, phones._id, "USB-C Cable", 29_900);
  return { vikram, meera, phoneId: phone.id as string, cableId: cable.id as string };
}

// A customer with the phone and two cables in the cart, checked out: one order, two parts, not yet paid.
async function placedOrder() {
  const s = await shop();
  const { accessToken: token } = await register(app, { email: "priya@example.com", name: "Priya Sharma" });
  const address = await api().post("/api/v1/account/addresses").set(bearer(token)).send({ name: "Priya Sharma", phone: "9876543210", line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001" });
  await api().post("/api/v1/cart/items").set(bearer(token)).set(withCsrf).send({ productId: s.phoneId, qty: 1 });
  await api().post("/api/v1/cart/items").set(bearer(token)).set(withCsrf).send({ productId: s.cableId, qty: 2 });
  const { order, payment } = (await api().post("/api/v1/checkout").set(bearer(token)).send({ addressId: address.body.address.id })).body;
  return { ...s, token, orderId: order.id as string, providerOrderId: payment.providerOrderId as string };
}

async function paidOrder() {
  const o = await placedOrder();
  const proof = payments.pay(o.providerOrderId);
  const paid = await api().post("/api/v1/checkout/verify").set(bearer(o.token)).send({ orderId: o.orderId, providerOrderId: o.providerOrderId, ...proof });
  expect(paid.status).toBe(200);
  const parts = await SubOrder.find({ orderId: o.orderId }).sort({ _id: 1 });
  return { ...o, paymentId: proof.providerPaymentId, vikramPart: parts[0]!.id as string, meeraPart: parts[1]!.id as string };
}

const move = (token: string, subId: string, body: Record<string, unknown>) => api().post(`/api/v1/vendor/orders/${subId}/status`).set(bearer(token)).send(body);
async function deliver(token: string, subId: string) {
  await move(token, subId, { status: "packed" });
  await move(token, subId, { status: "shipped", tracking: { carrier: "Delhivery", number: "DL123456" } });
  return move(token, subId, { status: "delivered" });
}

const sum = async (type: LedgerType) => (await LedgerEntry.find({ type })).reduce((n, e) => n + e.amount, 0);

const signed = (body: unknown, eventId: string, secret = "test-webhook-secret") => {
  const raw = JSON.stringify(body);
  return api()
    .post("/api/v1/webhooks/razorpay")
    .set("Content-Type", "application/json")
    .set("X-Razorpay-Event-Id", eventId)
    .set("X-Razorpay-Signature", createHmac("sha256", secret).update(raw).digest("hex"))
    .send(raw);
};
const captured = (orderId: string, paymentId: string) => ({ event: "payment.captured", payload: { payment: { entity: { id: paymentId, order_id: orderId, status: "captured" } } } });

describe("escrow and the ledger", () => {
  it("holds each vendor's share when the order is paid, and the books balance", async () => {
    const o = await paidOrder();
    const order = (await Order.findById(o.orderId))!;
    const parts = await SubOrder.find({ orderId: o.orderId }).sort({ _id: 1 });
    expect(parts.map((p) => [p.payout?.status, p.payout?.amount])).toEqual([
      ["held", 1_700_000],
      ["held", 50_830],
    ]);
    // What the customer paid = what the vendors are owed + what the platform keeps.
    expect(await sum("payment")).toBe(order.grandTotal);
    expect((await sum("vendor_hold")) + (await sum("commission"))).toBe(order.grandTotal);
    expect(await LedgerEntry.countDocuments()).toBe(5);

    const vendorView = await api().get("/api/v1/vendor/orders").set(bearer(o.vikram.token));
    expect(vendorView.body.items[0].payout).toMatchObject({ status: "held", amount: 1_700_000 });
  });

  it("releases the share on delivery and pays it once the vendor adds payout details", async () => {
    const o = await paidOrder();
    expect((await deliver(o.vikram.token, o.vikramPart)).body.part.payout).toMatchObject({ status: "released" });
    expect(await sum("vendor_release")).toBe(1_700_000);

    // No bank details yet: the payout waits.
    const badIfsc = await api().put("/api/v1/vendors/me/payout").set(bearer(o.vikram.token)).send({ accountHolder: "Vikram Rao", accountNumber: "123", ifsc: "hdfc1234" });
    expect(badIfsc.body.error.details.fields.map((f: { field: string }) => f.field).sort()).toEqual(["accountNumber", "ifsc"]);
    const saved = await api()
      .put("/api/v1/vendors/me/payout")
      .set(bearer(o.vikram.token))
      .send({ accountHolder: "Vikram Rao", accountNumber: "1234 5678 9012", ifsc: "hdfc0001234" });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ payoutsStarted: 1, store: { payout: { accountHolder: "Vikram Rao", bankLast4: "9012", ifsc: "HDFC0001234", provider: "mock" } } });
    // Only the last 4 digits are kept.
    expect(JSON.stringify(await Vendor.findById(o.vikram.storeId).lean())).not.toContain("123456789012");

    const part = (await SubOrder.findById(o.vikramPart))!;
    expect(part.payout).toMatchObject({ status: "paid", provider: "mock" });
    expect(part.payout!.providerRef).toMatch(/^pout_mock_/);
    expect(await sum("payout")).toBe(1_700_000);

    // A second delivery for a vendor with details is paid straight away.
    await api().put("/api/v1/vendors/me/payout").set(bearer(o.meera.token)).send({ accountHolder: "Meera Iyer", accountNumber: "987654321", ifsc: "SBIN0000001" });
    await deliver(o.meera.token, o.meeraPart);
    expect((await SubOrder.findById(o.meeraPart))!.payout!.status).toBe("paid");
    expect((await Order.findById(o.orderId))!.status).toBe("completed");
  });

  it("reverses the held share and refunds the customer when a part is cancelled", async () => {
    const o = await paidOrder();
    const res = await api().post(`/api/v1/orders/${o.orderId}/sub-orders/${o.meeraPart}/cancel`).set(bearer(o.token)).send({ reason: "Changed my mind" });
    expect(res.body.order.parts[1]).toMatchObject({ status: "cancelled", refund: { amount: 59_800, status: "processed" } });
    expect(res.body.order.payment).toMatchObject({ status: "partially_refunded", refundedAmount: 59_800 });

    const part = (await SubOrder.findById(o.meeraPart))!;
    expect(part.payout!.status).toBe("reversed");
    expect(part.refund!.providerRef).toMatch(/^rfnd_mock_/);
    expect([await sum("vendor_reversal"), await sum("commission_reversal"), await sum("refund")]).toEqual([50_830, 8_970, 59_800]);
    // Still balanced: money kept = held shares + commission, each minus what was reversed.
    const kept = (await sum("payment")) - (await sum("refund"));
    const owed = (await sum("vendor_hold")) - (await sum("vendor_reversal")) + (await sum("commission")) - (await sum("commission_reversal"));
    expect(kept).toBe(owed);
  });
});

describe("when the provider refuses", () => {
  it("shows a refused refund as failed and the hourly sweep sends it once refunds work again", async () => {
    const o = await paidOrder();
    payments.refuseRefunds = true;
    const res = await api().post(`/api/v1/orders/${o.orderId}/sub-orders/${o.meeraPart}/cancel`).set(bearer(o.token)).send({});
    // The cancellation itself succeeds: stock back, share reversed; only the money is still to be returned.
    expect(res.status).toBe(200);
    expect(res.body.order.parts[1]).toMatchObject({ status: "cancelled", refund: { amount: 59_800, status: "failed" } });
    expect((await SubOrder.findById(o.meeraPart))!.refund!.lastError).toContain("invalid request sent");
    expect(await sum("refund")).toBe(0);

    const deps = { payments, payouts: new MockPayoutProvider() };
    expect(await retryStuckMoney(deps, 0)).toBe("0 retried, 1 still failing");
    payments.refuseRefunds = false;
    expect(await retryStuckMoney(deps, 0)).toBe("1 retried, 0 still failing");
    const part = (await SubOrder.findById(o.meeraPart))!;
    expect(part.refund).toMatchObject({ status: "processed" });
    expect(part.refund!.lastError).toBeUndefined();
    expect(await sum("refund")).toBe(59_800);
    expect((await Order.findById(o.orderId))!.payment!.status).toBe("partially_refunded");
  });
});

describe("Razorpay webhooks", () => {
  it("refuses an unsigned or wrongly signed event", async () => {
    const o = await placedOrder();
    const unsigned = await api().post("/api/v1/webhooks/razorpay").send(captured(o.providerOrderId, "pay_1"));
    expect(unsigned.status).toBe(400);
    const wrong = await signed(captured(o.providerOrderId, "pay_1"), "evt_1", "not-the-secret");
    expect(wrong.status).toBe(400);
    expect((await Order.findById(o.orderId))!.status).toBe("pending_payment");
  });

  it("confirms an order the customer paid for but never came back from, once per event", async () => {
    const o = await placedOrder();
    const first = await signed(captured(o.providerOrderId, "pay_tab_closed"), "evt_1");
    expect(first.body).toMatchObject({ ok: true, result: "order confirmed" });
    const order = (await Order.findById(o.orderId))!;
    expect(order).toMatchObject({ status: "confirmed", payment: { status: "paid", providerPaymentId: "pay_tab_closed" } });

    // Razorpay delivers it again: acknowledged, nothing changes.
    const again = await signed(captured(o.providerOrderId, "pay_tab_closed"), "evt_1");
    expect(again.body).toMatchObject({ ok: true, duplicate: true });
    // A different event about the same payment (or the popup's callback) also changes nothing.
    expect((await signed(captured(o.providerOrderId, "pay_tab_closed"), "evt_2")).body.result).toBe("already confirmed");
    expect(await LedgerEntry.countDocuments({ type: "payment" })).toBe(1);
  });

  it("refunds in full a payment that arrives after the order expired", async () => {
    const o = await placedOrder();
    await Order.updateOne({ _id: o.orderId }, { reservationExpiresAt: new Date(Date.now() - 1000) });
    await api().post(`/api/v1/orders/${o.orderId}/cancel`).set(bearer(o.token));
    const late = await signed(captured(o.providerOrderId, "pay_late"), "evt_late");
    expect(late.body.result).toBe("late payment refunded");
    const order = (await Order.findById(o.orderId))!;
    expect(order.status).toBe("cancelled");
    expect(order.payment).toMatchObject({ status: "refunded", refundedAmount: order.grandTotal, providerPaymentId: "pay_late" });
    expect(await sum("refund")).toBe(order.grandTotal);

    // The popup's callback for the same late payment is refused and doesn't refund a second time.
    const proof = payments.pay(o.providerOrderId);
    const verify = await api().post("/api/v1/checkout/verify").set(bearer(o.token)).send({ orderId: o.orderId, providerOrderId: o.providerOrderId, ...proof });
    expect(verify.body.error.code).toBe("order_not_payable");
    expect(await LedgerEntry.countDocuments({ type: "refund" })).toBe(1);
  });

  it("marks a pending refund processed when Razorpay says so, even before our own record has its id", async () => {
    payments.refundStatus = "pending";
    const o = await paidOrder();
    await api().post(`/api/v1/orders/${o.orderId}/sub-orders/${o.meeraPart}/cancel`).set(bearer(o.token)).send({});
    expect((await SubOrder.findById(o.meeraPart))!.refund!.status).toBe("pending");
    const processed = await signed(
      { event: "refund.processed", payload: { refund: { entity: { id: "rfnd_anything", status: "processed", notes: { key: `refund-${o.meeraPart}` } } } } },
      "evt_refund",
    );
    expect(processed.body.result).toBe("refund processed");
    expect((await SubOrder.findById(o.meeraPart))!.refund!.status).toBe("processed");
  });

  it("keeps the order payable after a failed payment attempt and ignores unknown events", async () => {
    const o = await placedOrder();
    const failed = await signed({ event: "payment.failed", payload: { payment: { entity: { id: "pay_x", order_id: o.providerOrderId } } } }, "evt_f");
    expect(failed.body.result).toBe("attempt failed, order still payable");
    expect((await Order.findById(o.orderId))!).toMatchObject({ status: "pending_payment", payment: { status: "failed" } });
    expect((await signed({ event: "order.paid", payload: {} }, "evt_o")).body.result).toBe("ignored");
    // An event with no ids can't touch anything.
    expect((await signed({ event: "payment.captured", payload: { payment: { entity: {} } } }, "evt_empty")).body.result).toBe("ignored");
    expect(env.RAZORPAY_WEBHOOK_SECRET).toBe("test-webhook-secret");
  });
});
