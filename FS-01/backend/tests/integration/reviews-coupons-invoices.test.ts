import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { Category } from "../../src/modules/catalog/category.model.js";
import { Product } from "../../src/modules/catalog/product.model.js";
import { Coupon, CouponRedemption } from "../../src/modules/coupons/coupon.model.js";
import { Invoice } from "../../src/modules/invoices/invoice.model.js";
import { Counter, Order, SubOrder } from "../../src/modules/orders/order.model.js";
import { releaseReservation } from "../../src/modules/orders/order-service.js";
import { noReservations } from "../../src/modules/orders/reservations.js";
import { LedgerEntry, type LedgerType } from "../../src/modules/payments/ledger.model.js";
import type { MockPaymentProvider } from "../../src/modules/payments/payment-provider.js";
import { Review } from "../../src/modules/reviews/review.model.js";
import type { SearchSync } from "../../src/modules/search/search-sync.js";
import { User } from "../../src/modules/users/user.model.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { approvedVendor, bearer, register, signInAdmin, startTestServices, wipe, withCsrf } from "./helpers.js";

let app: Express;
let redis: Redis;
let payments: MockPaymentProvider;
let searchSync: SearchSync;

beforeAll(async () => {
  const services = await startTestServices();
  ({ app, redis, searchSync } = services);
  payments = services.payments as MockPaymentProvider;
  await Promise.all([User.init(), Vendor.init(), Category.init(), Product.init(), Order.init(), SubOrder.init(), Counter.init(), LedgerEntry.init(), Review.init(), Coupon.init(), CouponRedemption.init(), Invoice.init()]);
});

beforeEach(async () => {
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);

// Two stores at 10% commission: a ₹20,000 phone (Vikram) and ₹299 cables (Meera).
async function shop() {
  const admin = await signInAdmin(app);
  const cat = await Category.create({ name: "Phones", slug: "phones" });
  const vikram = await approvedVendor(app, admin, "vikram@example.com", "Vikram Electronics");
  const meera = await approvedVendor(app, admin, "meera@example.com", "Meera Gadgets");
  const product = (vendorId: string, categoryId: Types.ObjectId, title: string, price: number) =>
    Product.create({ vendorId, categoryId, title, slug: title.toLowerCase().replace(/\W+/g, "-"), price, mrp: price, stock: 10, status: "active", images: [{ key: `products/${vendorId}/a.png`, alt: "" }] });
  const phone = await product(vikram.storeId, cat._id, "Galaxy Phone", 2_000_000);
  const cable = await product(meera.storeId, cat._id, "USB-C Cable", 29_900);
  return { admin, vikram, meera, phoneId: phone.id as string, cableId: cable.id as string };
}

async function customer(email = "priya@example.com", name = "Priya Sharma") {
  const { accessToken: token } = await register(app, { email, name });
  const address = await api().post("/api/v1/account/addresses").set(bearer(token)).send({ name, phone: "9876543210", line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001" });
  return { token, addressId: address.body.address.id as string };
}

const add = (token: string, productId: string, qty = 1) => api().post("/api/v1/cart/items").set(bearer(token)).set(withCsrf).send({ productId, qty });
const applyCode = (token: string, code: string) => api().post("/api/v1/cart/coupon").set(bearer(token)).set(withCsrf).send({ code });
const checkout = (c: { token: string; addressId: string }, expectedTotal?: number) => api().post("/api/v1/checkout").set(bearer(c.token)).send({ addressId: c.addressId, expectedTotal });

async function pay(token: string, order: { id: string }, providerOrderId: string) {
  const proof = payments.pay(providerOrderId);
  const res = await api().post("/api/v1/checkout/verify").set(bearer(token)).send({ orderId: order.id, providerOrderId, ...proof });
  expect(res.status).toBe(200);
  return res.body.order;
}

const move = (token: string, subId: string, body: Record<string, unknown>) => api().post(`/api/v1/vendor/orders/${subId}/status`).set(bearer(token)).send(body);
async function deliver(token: string, subId: string) {
  await move(token, subId, { status: "packed" });
  await move(token, subId, { status: "shipped", tracking: { carrier: "Delhivery", number: "DL123456" } });
  await move(token, subId, { status: "delivered" });
}

const sum = async (type: LedgerType) => (await LedgerEntry.find({ type })).reduce((n, e) => n + e.amount, 0);

describe("reviews", () => {
  it("only lets a customer review what was delivered to them, once, and keeps ratings in step", async () => {
    const s = await shop();
    const c = await customer();
    await add(c.token, s.phoneId);
    const { order, payment } = (await checkout(c)).body;
    await pay(c.token, order, payment.providerOrderId);

    const early = await api().post(`/api/v1/products/${s.phoneId}/reviews`).set(bearer(c.token)).send({ rating: 5, body: "Arrived yet? Not yet." });
    expect(early.status).toBe(403);
    expect(early.body.error.code).toBe("not_delivered");
    const before = await api().get(`/api/v1/products/${s.phoneId}/reviews`).set(bearer(c.token));
    expect(before.body.viewer).toMatchObject({ canReview: false, reason: "not_delivered" });

    const part = (await SubOrder.findOne({ orderId: order.id }))!;
    await deliver(s.vikram.token, part.id as string);
    const after = await api().get(`/api/v1/products/${s.phoneId}/reviews`).set(bearer(c.token));
    expect(after.body.viewer).toMatchObject({ canReview: true, reason: null });

    const bad = await api().post(`/api/v1/products/${s.phoneId}/reviews`).set(bearer(c.token)).send({ rating: 6, body: "short" });
    expect(bad.body.error.details.fields.map((f: { field: string }) => f.field).sort()).toEqual(["body", "rating"]);

    const posted = await api().post(`/api/v1/products/${s.phoneId}/reviews`).set(bearer(c.token)).send({ rating: 4, title: "Great phone", body: "Battery lasts two days. Camera is good." });
    expect(posted.status).toBe(201);
    expect(posted.body).toMatchObject({ review: { rating: 4, authorName: "Priya Sharma", verified: true }, summary: { ratingAvg: 4, ratingCount: 1 } });
    expect((await api().post(`/api/v1/products/${s.phoneId}/reviews`).set(bearer(c.token)).send({ rating: 5, body: "Second try at a review" })).body.error.code).toBe("already_reviewed");

    // A seeded review joins the average.
    await Review.create({ productId: s.phoneId, vendorId: s.vikram.storeId, authorName: "Seed Reviewer", rating: 2, body: "Meh", source: "seed" });
    const list = await api().get(`/api/v1/products/${s.phoneId}/reviews`);
    expect(list.body.total).toBe(2);
    expect(list.body.viewer).toBeNull();
    expect((await Product.findById(s.phoneId))!.ratingAvg).toBe(4);
    expect((await Vendor.findById(s.vikram.storeId))!).toMatchObject({ ratingAvg: 4, ratingCount: 1 });

    // An admin hides the customer's review: it leaves the page and the ratings.
    const hidden = await api().patch(`/api/v1/admin/reviews/${posted.body.review.id}`).set(bearer(s.admin)).send({ status: "hidden", reason: "Test" });
    expect(hidden.body.review.status).toBe("hidden");
    expect((await Product.findById(s.phoneId))!).toMatchObject({ ratingAvg: 2, ratingCount: 1 });
    const page = await api().get(`/api/v1/products/${s.phoneId}/reviews`);
    expect(page.body.items.map((r: { authorName: string }) => r.authorName)).toEqual(["Seed Reviewer"]);
    expect(page.body.summary.stars).toEqual({ 5: 0, 4: 0, 3: 0, 2: 1, 1: 0 });
    expect((await api().patch(`/api/v1/admin/reviews/${posted.body.review.id}`).set(bearer(c.token)).send({ status: "visible" })).status).toBe(403);
  });
});

describe("coupons", () => {
  it("admin and vendors manage their own coupons, with checks", async () => {
    const s = await shop();
    const bad = await api().post("/api/v1/admin/coupons").set(bearer(s.admin)).send({ code: "big sale", type: "percent", value: 9500 });
    expect(bad.body.error.details.fields.map((f: { field: string }) => f.field)).toEqual(["code"]);
    const tooMuch = await api().post("/api/v1/admin/coupons").set(bearer(s.admin)).send({ code: "BIGSALE", type: "percent", value: 9500 });
    expect(tooMuch.body.error.details.fields[0]).toMatchObject({ field: "value" });
    const ok = await api().post("/api/v1/admin/coupons").set(bearer(s.admin)).send({ code: "welcome10", type: "percent", value: 1000, maxDiscount: 20_000, minOrder: 49_900 });
    expect(ok.body.coupon).toMatchObject({ code: "WELCOME10", scope: "platform", vendorId: null });
    expect((await api().post("/api/v1/admin/coupons").set(bearer(s.admin)).send({ code: "WELCOME10", type: "flat", value: 100 })).body.error.code).toBe("code_taken");

    const mine = await api().post("/api/v1/vendor/coupons").set(bearer(s.vikram.token)).send({ code: "VIKRAM5", type: "percent", value: 500 });
    expect(mine.body.coupon).toMatchObject({ scope: "vendor", vendorId: s.vikram.storeId });
    expect((await api().get("/api/v1/vendor/coupons").set(bearer(s.meera.token))).body.total).toBe(0);
    expect((await api().patch(`/api/v1/vendor/coupons/${mine.body.coupon.id}`).set(bearer(s.meera.token)).send({ isActive: false })).status).toBe(404);
    const off = await api().patch(`/api/v1/vendor/coupons/${mine.body.coupon.id}`).set(bearer(s.vikram.token)).send({ isActive: false });
    expect(off.body.coupon.isActive).toBe(false);
  });

  it("a platform coupon: shown in the cart, charged at checkout, paid for by the platform, and the books balance", async () => {
    const s = await shop();
    await Coupon.create({ code: "WELCOME10", scope: "platform", type: "percent", value: 1000, maxDiscount: 20_000, minOrder: 49_900 });
    const c = await customer();
    await add(c.token, s.phoneId);
    await add(c.token, s.cableId, 2);
    expect((await applyCode(c.token, "nope")).body.error).toMatchObject({ code: "coupon_invalid", message: "This code isn't valid." });
    const applied = await applyCode(c.token, "welcome10");
    expect(applied.body.cart).toMatchObject({ coupon: { code: "WELCOME10", scope: "platform" }, couponProblem: null, discount: 20_000, itemsTotal: 2_059_800, grandTotal: 2_039_800 });

    // The total the shopper saw (after the discount) is what checkout compares.
    const res = await checkout(c, 2_039_800);
    expect(res.status).toBe(201);
    expect(res.body.order).toMatchObject({ discount: 20_000, grandTotal: 2_039_800, coupon: { code: "WELCOME10", scope: "platform" } });
    expect(res.body.payment.amount).toBe(2_039_800);
    expect(res.body.order.parts.map((p: { discountShare: number; payable: number }) => [p.discountShare, p.payable])).toEqual([
      [19_420, 1_980_580],
      [580, 59_220],
    ]);
    expect((await api().get("/api/v1/cart").set(bearer(c.token))).body.cart.coupon).toBeNull();

    await pay(c.token, res.body.order, res.body.payment.providerOrderId);
    // Vendors are owed their full share; the platform covers the discount.
    expect(await sum("platform_discount")).toBe(20_000);
    expect((await sum("payment")) + (await sum("platform_discount"))).toBe((await sum("vendor_hold")) + (await sum("commission")));
    expect((await Coupon.findOne({ code: "WELCOME10" }))!.usedCount).toBe(1);

    // Once per customer.
    await add(c.token, s.phoneId);
    expect((await applyCode(c.token, "WELCOME10")).body.error.message).toBe("You've already used this coupon.");

    // Cancelling a part undoes its share of the discount, and the books still balance.
    const meeraPart = res.body.order.parts[1].id;
    const cancelled = await api().post(`/api/v1/orders/${res.body.order.id}/sub-orders/${meeraPart}/cancel`).set(bearer(c.token)).send({});
    expect(cancelled.body.order.parts[1].refund).toMatchObject({ amount: 59_220 });
    expect(await sum("platform_discount_reversal")).toBe(580);
    const kept = (await sum("payment")) - (await sum("refund")) + (await sum("platform_discount")) - (await sum("platform_discount_reversal"));
    const owed = (await sum("vendor_hold")) - (await sum("vendor_reversal")) + (await sum("commission")) - (await sum("commission_reversal"));
    expect(kept).toBe(owed);
  });

  it("a vendor coupon: only that store's part, paid for by the store", async () => {
    const s = await shop();
    await Coupon.create({ code: "VIKRAM5", scope: "vendor", vendorId: s.vikram.storeId, type: "percent", value: 500, minOrder: 100_000 });
    const c = await customer();
    await add(c.token, s.cableId, 2);
    expect((await applyCode(c.token, "VIKRAM5")).body.error.message).toMatch(/nothing in your cart/);
    await add(c.token, s.phoneId);
    expect((await applyCode(c.token, "VIKRAM5")).body.cart).toMatchObject({ discount: 100_000, grandTotal: 1_959_800, coupon: { scope: "vendor", storeName: "Vikram Electronics" } });
    const res = await checkout(c, 1_959_800);
    await pay(c.token, res.body.order, res.body.payment.providerOrderId);
    const parts = await SubOrder.find({ orderId: res.body.order.id }).sort({ _id: 1 });
    expect(parts.map((p) => [p.discountBy ?? null, p.payable, p.commission, p.vendorNet])).toEqual([
      [null, 59_800, 5_980, 53_820],
      ["vendor", 1_900_000, 190_000, 1_710_000],
    ]);
    expect(await sum("platform_discount")).toBe(0);
    expect(await sum("payment")).toBe((await sum("vendor_hold")) + (await sum("commission")));
  });

  it("the last use goes to one shopper only, and an unpaid order gives its use back", async () => {
    const s = await shop();
    await Coupon.create({ code: "LASTONE", scope: "platform", type: "flat", value: 10_000, usageLimit: 1 });
    const a = await customer("a@example.com", "Asha");
    const b = await customer("b@example.com", "Bilal");
    for (const c of [a, b]) {
      await add(c.token, s.phoneId);
      expect((await applyCode(c.token, "LASTONE")).status).toBe(200);
    }
    const results = await Promise.all([checkout(a), checkout(b)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(["coupon_exhausted", "coupon_invalid"]).toContain(loser.body.error.code);
    expect((await Coupon.findOne({ code: "LASTONE" }))!.usedCount).toBe(1);

    const won = results.find((r) => r.status === 201)!.body.order;
    await Order.updateOne({ _id: won.id }, { reservationExpiresAt: new Date(Date.now() - 1000) });
    await releaseReservation({ redis, searchSync, reservations: noReservations }, won.id, { to: "expired", reason: "Not paid in time", actor: { role: "system" }, onlyIfDue: true });
    expect((await Coupon.findOne({ code: "LASTONE" }))!.usedCount).toBe(0);
    expect(await CouponRedemption.countDocuments()).toBe(0);
  });
});

describe("invoices", () => {
  it("makes one PDF per store's part once paid, downloadable only by the buyer, the seller and admins", async () => {
    const s = await shop();
    const c = await customer();
    await add(c.token, s.phoneId);
    await add(c.token, s.cableId);
    const { order, payment } = (await checkout(c)).body;
    const parts = order.parts as { id: string }[];
    expect((await api().get(`/api/v1/invoices/${parts[0]!.id}`).set(bearer(c.token))).body.error.code).toBe("not_found");

    const paid = await pay(c.token, order, payment.providerOrderId);
    const view = await api().get(`/api/v1/orders/${order.id}`).set(bearer(c.token));
    expect(view.body.order.parts.map((p: { invoiceNumber: string }) => p.invoiceNumber).sort()).toEqual(["INV-2026-000001", "INV-2026-000002"].map((n) => n.replace("2026", String(new Date().getUTCFullYear()))));
    expect(paid.status).toBe("confirmed");

    const link = await api().get(`/api/v1/invoices/${parts[0]!.id}`).set(bearer(c.token));
    expect(link.status).toBe(200);
    expect(link.body).toMatchObject({ expiresInSeconds: 300 });
    const file = await fetch(link.body.url);
    expect(file.ok).toBe(true);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString()).toBe("%PDF-");

    expect((await api().get(`/api/v1/invoices/${parts[0]!.id}`).set(bearer(s.vikram.token))).status).toBe(200);
    expect((await api().get(`/api/v1/invoices/${parts[0]!.id}`).set(bearer(s.meera.token))).status).toBe(404);
    expect((await api().get(`/api/v1/invoices/${parts[0]!.id}`).set(bearer(s.admin))).status).toBe(200);
    const stranger = await customer("someone@example.com", "Someone");
    expect((await api().get(`/api/v1/invoices/${parts[0]!.id}`).set(bearer(stranger.token))).status).toBe(404);
    expect(await Invoice.countDocuments()).toBe(2);
  });
});
