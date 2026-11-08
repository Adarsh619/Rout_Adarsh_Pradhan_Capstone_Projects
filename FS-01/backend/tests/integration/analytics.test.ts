import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { todayIst } from "../../src/modules/analytics/date-range.js";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { Category } from "../../src/modules/catalog/category.model.js";
import { Product } from "../../src/modules/catalog/product.model.js";
import { Coupon, CouponRedemption } from "../../src/modules/coupons/coupon.model.js";
import { Counter, Order, SubOrder } from "../../src/modules/orders/order.model.js";
import { LedgerEntry } from "../../src/modules/payments/ledger.model.js";
import { MockPaymentProvider, PaymentProviderError } from "../../src/modules/payments/payment-provider.js";
import { User } from "../../src/modules/users/user.model.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { approvedVendor, bearer, register, signInAdmin, startTestServices, wipe, withCsrf } from "./helpers.js";

class TestPayments extends MockPaymentProvider {
  refuseRefunds = false;
  override async refund(input: { providerPaymentId: string; amount: number; key: string }) {
    if (this.refuseRefunds) throw new PaymentProviderError("invalid request sent", 400);
    return super.refund(input);
  }
}
const payments = new TestPayments("analytics-test-secret");

let app: Express;
let redis: Redis;

beforeAll(async () => {
  ({ app, redis } = await startTestServices({ payments }));
  await Promise.all([User.init(), Vendor.init(), Category.init(), Product.init(), Order.init(), SubOrder.init(), Counter.init(), LedgerEntry.init(), Coupon.init(), CouponRedemption.init()]);
});

beforeEach(async () => {
  payments.refuseRefunds = false;
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);

// Two stores at 10%: a ₹20,000 phone (Vikram) and ₹299 cables (Meera).
async function shop() {
  const admin = await signInAdmin(app);
  const cat = await Category.create({ name: "Phones", slug: "phones" });
  const vikram = await approvedVendor(app, admin, "vikram@example.com", "Vikram Electronics");
  const meera = await approvedVendor(app, admin, "meera@example.com", "Meera Gadgets");
  const product = (vendorId: string, categoryId: Types.ObjectId, title: string, price: number) =>
    Product.create({ vendorId, categoryId, title, slug: title.toLowerCase().replace(/\W+/g, "-"), price, mrp: price, stock: 20, status: "active", images: [{ key: `products/${vendorId}/a.png`, alt: "" }] });
  const phone = await product(vikram.storeId, cat._id, "Galaxy Phone", 2_000_000);
  const cable = await product(meera.storeId, cat._id, "USB-C Cable", 29_900);
  return { admin, vikram, meera, phoneId: phone.id as string, cableId: cable.id as string };
}

async function customer(email = "priya@example.com") {
  const { accessToken: token } = await register(app, { email, name: "Priya Sharma" });
  const address = await api().post("/api/v1/account/addresses").set(bearer(token)).send({ name: "Priya Sharma", phone: "9876543210", line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001" });
  return { token, addressId: address.body.address.id as string };
}

// Buys what's given and pays for it; returns the order and its parts (oldest line's store first).
async function buy(c: { token: string; addressId: string }, lines: [string, number][], code?: string) {
  for (const [productId, qty] of lines) await api().post("/api/v1/cart/items").set(bearer(c.token)).set(withCsrf).send({ productId, qty });
  if (code) await api().post("/api/v1/cart/coupon").set(bearer(c.token)).set(withCsrf).send({ code });
  const { order, payment } = (await api().post("/api/v1/checkout").set(bearer(c.token)).send({ addressId: c.addressId })).body;
  const proof = payments.pay(payment.providerOrderId);
  await api().post("/api/v1/checkout/verify").set(bearer(c.token)).send({ orderId: order.id, providerOrderId: payment.providerOrderId, ...proof });
  return { orderId: order.id as string, parts: (await SubOrder.find({ orderId: order.id }).sort({ _id: 1 })).map((p) => p.id as string) };
}

const move = (token: string, subId: string, status: string) =>
  api().post(`/api/v1/vendor/orders/${subId}/status`).set(bearer(token)).send({ status, ...(status === "shipped" && { tracking: { carrier: "Delhivery", number: "DL123456" } }) });
async function deliver(token: string, subId: string) {
  for (const s of ["packed", "shipped", "delivered"]) await move(token, subId, s);
}

describe("admin analytics", () => {
  it("adds up sales, commission, discounts, refunds and escrow, by day, store and product", async () => {
    const s = await shop();
    await Coupon.create({ code: "WELCOME10", scope: "platform", type: "percent", value: 1000, maxDiscount: 20_000 });
    await api().put("/api/v1/vendors/me/payout").set(bearer(s.vikram.token)).send({ accountHolder: "Vikram", accountNumber: "123456789012", ifsc: "HDFC0001234" });
    const c = await customer();
    // Order 1: phone + 2 cables with WELCOME10; the phone is delivered (paid out), the cables cancelled (refunded).
    const one = await buy(c, [[s.phoneId, 1], [s.cableId, 2]], "WELCOME10");
    await deliver(s.vikram.token, one.parts[0]!);
    await api().post(`/api/v1/orders/${one.orderId}/sub-orders/${one.parts[1]}/cancel`).set(bearer(c.token)).send({});
    // Order 2: 3 cables, still held.
    await buy(c, [[s.cableId, 3]]);

    const res = await api().get("/api/v1/admin/analytics").set(bearer(s.admin));
    expect(res.status).toBe(200);
    const { totals } = res.body;
    // Paid in: 2 039 800 + 89 700; refunded: Meera's part of order 1 (59 800 − 580 discount share).
    expect(totals).toMatchObject({
      gmv: 2_059_800 + 89_700,
      cancelledValue: 59_800,
      refunds: 59_220,
      collected: 2_039_800 + 89_700 - 59_220,
      paidOrders: 2,
      averageOrderValue: Math.round((2_039_800 + 89_700) / 2),
      commission: 200_000 + 8_970,
      platformDiscounts: 20_000 - 580,
      platformRevenue: 200_000 + 8_970 - 19_420,
      payoutsSent: 1_800_000,
    });
    expect(res.body.ordersByStatus).toEqual({ completed: 1, confirmed: 1 });
    expect(res.body.partsByStatus).toEqual({ delivered: 1, cancelled: 1, placed: 1 });
    expect(res.body.daily).toHaveLength(30);
    expect(res.body.daily.at(-1)).toEqual({ day: todayIst(), sales: 2_039_800 + 89_700, orders: 2 });
    expect(res.body.topVendors.map((v: { storeName: string; sales: number }) => [v.storeName, v.sales])).toEqual([
      ["Vikram Electronics", 2_000_000],
      ["Meera Gadgets", 89_700],
    ]);
    expect(res.body.topProducts[1]).toMatchObject({ title: "USB-C Cable", units: 3, sales: 89_700 });
    expect(res.body.escrow).toMatchObject({ held: 80_730, released: 0, paid: 1_800_000, reversed: 53_820 });
    expect(res.body).toMatchObject({ failingRefunds: 0, refundsOwed: 0 });
  });

  it("checks the range and is for admins only", async () => {
    const s = await shop();
    expect((await api().get("/api/v1/admin/analytics?from=2026-11-08&to=2026-11-01").set(bearer(s.admin))).status).toBe(400);
    expect((await api().get("/api/v1/admin/analytics?from=2026-13-01").set(bearer(s.admin))).status).toBe(400);
    expect((await api().get("/api/v1/admin/analytics").set(bearer(s.vikram.token))).status).toBe(403);
    const empty = await api().get("/api/v1/admin/analytics?from=2020-01-01&to=2020-01-31").set(bearer(s.admin));
    expect(empty.body.totals).toMatchObject({ gmv: 0, collected: 0, paidOrders: 0, averageOrderValue: 0 });
    expect(empty.body.daily).toHaveLength(31);
  });
});

describe("vendor earnings", () => {
  it("shows each store only its own sales, its share and where its money is", async () => {
    const s = await shop();
    await Coupon.create({ code: "VIKRAM5", scope: "vendor", vendorId: s.vikram.storeId, type: "percent", value: 500 });
    const c = await customer();
    const order = await buy(c, [[s.phoneId, 1], [s.cableId, 1]], "VIKRAM5");
    await deliver(s.vikram.token, order.parts[0]!);

    const vikram = await api().get("/api/v1/vendor/earnings").set(bearer(s.vikram.token));
    expect(vikram.body).toMatchObject({
      totals: { sales: 2_000_000, couponDiscounts: 100_000, commission: 190_000, net: 1_710_000, orders: 1 },
      // Delivered, but no payout account yet: released and waiting.
      escrow: { held: 0, released: 1_710_000, paid: 0 },
      payoutAccount: false,
      total: 1,
    });
    expect(vikram.body.items[0]).toMatchObject({ status: "delivered", payout: { status: "released" } });
    const meera = await api().get("/api/v1/vendor/earnings").set(bearer(s.meera.token));
    expect(meera.body).toMatchObject({ totals: { sales: 29_900, net: 26_910 }, escrow: { held: 26_910 } });
    expect((await api().get("/api/v1/vendor/earnings").set(bearer(s.admin))).status).toBe(403);
  });
});

describe("admin tools", () => {
  it("sets a store's own commission rate for new orders only", async () => {
    const s = await shop();
    const c = await customer();
    const before = await buy(c, [[s.phoneId, 1]]);
    const set = await api().patch(`/api/v1/admin/vendors/${s.vikram.storeId}/commission`).set(bearer(s.admin)).send({ commissionRateBp: 500 });
    expect(set.body.store.commissionRateBp).toBe(500);
    expect((await api().patch(`/api/v1/admin/vendors/${s.vikram.storeId}/commission`).set(bearer(s.admin)).send({ commissionRateBp: 6000 })).status).toBe(400);
    expect((await api().patch(`/api/v1/admin/vendors/${s.vikram.storeId}/commission`).set(bearer(s.vikram.token)).send({ commissionRateBp: 0 })).status).toBe(403);
    const after = await buy(c, [[s.phoneId, 1]]);
    expect((await SubOrder.findById(before.parts[0]))!.commission).toBe(200_000);
    expect((await SubOrder.findById(after.parts[0]))!.commission).toBe(100_000);
    await api().patch(`/api/v1/admin/vendors/${s.vikram.storeId}/commission`).set(bearer(s.admin)).send({ commissionRateBp: null });
    expect((await Vendor.findById(s.vikram.storeId))!.commissionRateBp).toBeNull();
  });

  it("lets support refund a shipped part, finds orders by number or email, and retries a refused refund", async () => {
    const s = await shop();
    const c = await customer();
    const order = await buy(c, [[s.phoneId, 1], [s.cableId, 1]]);
    await move(s.vikram.token, order.parts[0]!, "packed");
    await move(s.vikram.token, order.parts[0]!, "shipped");
    await deliver(s.meera.token, order.parts[1]!);

    expect((await api().post(`/api/v1/admin/sub-orders/${order.parts[1]}/refund`).set(bearer(s.admin)).send({ reason: "Customer complaint" })).body.error.code).toBe("invalid_transition");
    expect((await api().post(`/api/v1/admin/sub-orders/${order.parts[0]}/refund`).set(bearer(c.token)).send({ reason: "Please refund me" })).status).toBe(403);

    payments.refuseRefunds = true;
    const refunded = await api().post(`/api/v1/admin/sub-orders/${order.parts[0]}/refund`).set(bearer(s.admin)).send({ reason: "Parcel lost in transit" });
    expect(refunded.body.part).toMatchObject({ status: "cancelled", refund: { amount: 2_000_000, status: "failed" } });
    const timeline = (await SubOrder.findById(order.parts[0]))!.statusHistory.at(-1)!;
    expect(timeline).toMatchObject({ status: "cancelled", byRole: "admin", note: "Parcel lost in transit" });

    const failing = await api().get("/api/v1/admin/orders?refund=failed").set(bearer(s.admin));
    expect(failing.body.total).toBe(1);
    expect(failing.body.items[0].parts[0]).toMatchObject({ refund: { status: "failed" }, canRefund: false });
    expect((await api().get("/api/v1/admin/analytics").set(bearer(s.admin))).body).toMatchObject({ failingRefunds: 1, refundsOwed: 2_000_000 });

    payments.refuseRefunds = false;
    const retried = await api().post(`/api/v1/admin/sub-orders/${order.parts[0]}/refund/retry`).set(bearer(s.admin));
    expect(retried.body.refund).toMatchObject({ status: "processed", lastError: null });
    expect((await api().post(`/api/v1/admin/sub-orders/${order.parts[0]}/refund/retry`).set(bearer(s.admin))).status).toBe(409);

    const orderNumber = (await Order.findById(order.orderId))!.orderNumber;
    expect((await api().get(`/api/v1/admin/orders?q=${orderNumber.slice(-3)}`).set(bearer(s.admin))).body.items[0].orderNumber).toBe(orderNumber);
    expect((await api().get("/api/v1/admin/orders?q=PRIYA@example.com").set(bearer(s.admin))).body.total).toBe(1);
    expect((await api().get("/api/v1/admin/orders?q=nobody@example.com").set(bearer(s.admin))).body.total).toBe(0);
  });
});
