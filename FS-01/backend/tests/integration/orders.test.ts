import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Types } from "mongoose";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { Category } from "../../src/modules/catalog/category.model.js";
import { Product } from "../../src/modules/catalog/product.model.js";
import { Counter, Order, SubOrder } from "../../src/modules/orders/order.model.js";
import { expireDueOrders, releaseReservation } from "../../src/modules/orders/order-service.js";
import { noReservations } from "../../src/modules/orders/reservations.js";
import type { SearchSync } from "../../src/modules/search/search-sync.js";
import { User } from "../../src/modules/users/user.model.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { approvedVendor, bearer, PASSWORD, register, signInAdmin, startTestServices, wipe, withCsrf } from "./helpers.js";

let app: Express;
let redis: Redis;
let searchSync: SearchSync;

beforeAll(async () => {
  ({ app, redis, searchSync } = await startTestServices());
  await Promise.all([User.init(), Vendor.init(), Category.init(), Product.init(), Order.init(), SubOrder.init(), Counter.init()]);
});

beforeEach(async () => {
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);

const ADDRESS = {
  name: "Priya Sharma",
  phone: "+91 98765 43210",
  line1: "12 MG Road",
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560001",
};

// Two approved stores selling in a category with its own 15% commission (the department has 5%).
async function shop() {
  const admin = await signInAdmin(app);
  const dept = await Category.create({ name: "Electronics", slug: "electronics", commissionRateBp: 500 });
  const phones = await Category.create({ name: "Phones", slug: "phones", parentId: dept._id, commissionRateBp: 1500 });
  const cables = await Category.create({ name: "Cables", slug: "cables", parentId: dept._id });
  const vikram = await approvedVendor(app, admin, "vikram@example.com", "Vikram Electronics");
  const meera = await approvedVendor(app, admin, "meera@example.com", "Meera Gadgets");
  const product = (vendorId: string, categoryId: Types.ObjectId, title: string, price: number, stock: number) =>
    Product.create({
      vendorId,
      categoryId,
      title,
      slug: title.toLowerCase().replace(/\W+/g, "-"),
      price,
      mrp: price,
      stock,
      status: "active",
      images: [{ key: `products/${vendorId}/${title.length}.png`, alt: "" }],
    });
  const phone = await product(vikram.storeId, phones._id, "Galaxy Phone", 2_000_000, 5);
  const case_ = await product(vikram.storeId, phones._id, "Phone Case", 49_900, 20);
  const cable = await product(meera.storeId, cables._id, "USB-C Cable", 29_900, 3);
  return { admin, vikram, meera, phone, case_, cable, ids: { phone: phone.id as string, case_: case_.id as string, cable: cable.id as string } };
}

async function customer(email = "priya@example.com") {
  const { accessToken } = await register(app, { email, name: "Priya Sharma" });
  const added = await api().post("/api/v1/account/addresses").set(bearer(accessToken)).send(ADDRESS);
  return { token: accessToken, addressId: added.body.address.id as string };
}

const addToCart = (token: string, productId: string, qty = 1) =>
  api().post("/api/v1/cart/items").set(bearer(token)).set(withCsrf).send({ productId, qty });

const checkout = (token: string, addressId: string, extra: Record<string, unknown> = {}) =>
  api().post("/api/v1/checkout").set(bearer(token)).send({ addressId, ...extra });

// Plays the customer pressing Pay on the test payment screen, then the app verifying the signed result.
async function pay(token: string, orderId: string, providerOrderId: string) {
  const gateway = await api().post("/api/v1/payments/mock/pay").set(bearer(token)).send({ providerOrderId });
  expect(gateway.status).toBe(200);
  return api()
    .post("/api/v1/checkout/verify")
    .set(bearer(token))
    .send({ orderId, providerOrderId, providerPaymentId: gateway.body.providerPaymentId, signature: gateway.body.signature });
}

const stockOf = async (id: string) => (await Product.findById(id))!.stock;

describe("addresses", () => {
  it("keeps exactly one default, normalises phone numbers and allows up to 5", async () => {
    const { accessToken: token } = await register(app);
    const first = await api().post("/api/v1/account/addresses").set(bearer(token)).send(ADDRESS);
    expect(first.status).toBe(201);
    expect(first.body.address).toMatchObject({ phone: "9876543210", isDefault: true, line2: null });

    const second = await api().post("/api/v1/account/addresses").set(bearer(token)).send({ ...ADDRESS, label: "Office", isDefault: true });
    expect(second.body.items.map((a: { isDefault: boolean }) => a.isDefault)).toEqual([false, true]);

    const removed = await api().delete(`/api/v1/account/addresses/${second.body.address.id}`).set(bearer(token));
    expect(removed.body.items).toHaveLength(1);
    expect(removed.body.items[0].isDefault).toBe(true);

    const bad = await api().post("/api/v1/account/addresses").set(bearer(token)).send({ ...ADDRESS, phone: "12345", pincode: "0123" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fields.map((f: { field: string }) => f.field).sort()).toEqual(["phone", "pincode"]);

    for (let i = 0; i < 4; i++) await api().post("/api/v1/account/addresses").set(bearer(token)).send(ADDRESS);
    const sixth = await api().post("/api/v1/account/addresses").set(bearer(token)).send(ADDRESS);
    expect(sixth.status).toBe(409);
    expect(sixth.body.error.code).toBe("too_many_addresses");
  });
});

describe("cart", () => {
  it("gives a guest a cookie cart, grouped by store with live prices", async () => {
    const { ids } = await shop();
    const add = await api().post("/api/v1/cart/items").set(withCsrf).send({ productId: ids.phone, qty: 2 });
    expect(add.status).toBe(201);
    const cookie = ([] as string[]).concat(add.headers["set-cookie"] ?? []).find((c) => c.startsWith("ss_guest="))!;
    expect(cookie).toMatch(/HttpOnly/);
    const guest = cookie.split(";")[0]!;

    await api().post("/api/v1/cart/items").set("Cookie", guest).set(withCsrf).send({ productId: ids.cable });
    await Product.updateOne({ _id: ids.phone }, { price: 1_900_000 });
    const cart = await api().get("/api/v1/cart").set("Cookie", guest);
    expect(cart.body.cart.groups.map((g: { vendor: { storeName: string } }) => g.vendor.storeName)).toEqual(["Meera Gadgets", "Vikram Electronics"]);
    expect(cart.body.cart).toMatchObject({ itemCount: 3, itemsTotal: 2 * 1_900_000 + 29_900, canCheckout: true });

    // Without the header a guest write is refused (it acts on a cookie, so it needs CSRF protection).
    const noHeader = await api().post("/api/v1/cart/items").set("Cookie", guest).send({ productId: ids.case_ });
    expect(noHeader.status).toBe(403);
  });

  it("merges the guest cart into the account on sign-in", async () => {
    const { ids } = await shop();
    const { token } = await customer();
    await addToCart(token, ids.phone, 1);

    const guestAdd = await api().post("/api/v1/cart/items").set(withCsrf).send({ productId: ids.phone, qty: 2 });
    const guest = ([] as string[]).concat(guestAdd.headers["set-cookie"] ?? [])[0]!.split(";")[0]!;
    await api().post("/api/v1/cart/items").set("Cookie", guest).set(withCsrf).send({ productId: ids.cable });

    const login = await api().post("/api/v1/auth/login").set("Cookie", guest).send({ email: "priya@example.com", password: PASSWORD });
    expect(login.status).toBe(200);
    expect(([] as string[]).concat(login.headers["set-cookie"] ?? []).some((c) => c.startsWith("ss_guest=;"))).toBe(true);

    const cart = await api().get("/api/v1/cart").set(bearer(login.body.accessToken));
    const lines = cart.body.cart.groups.flatMap((g: { items: { title: string; qty: number }[] }) => g.items.map((i) => `${i.title} ×${i.qty}`));
    expect(lines.sort()).toEqual(["Galaxy Phone ×3", "USB-C Cable ×1"]);
    expect(await redis.exists(`cart:guest:${guest.split("=")[1]}`)).toBe(0);
  });

  it("checks stock and availability, and flags lines that changed", async () => {
    const { ids, vikram } = await shop();
    const { token } = await customer();
    expect((await addToCart(token, ids.cable, 3)).status).toBe(201);
    const tooMany = await addToCart(token, ids.cable, 1);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error).toMatchObject({ code: "out_of_stock", details: { available: 3, inCart: 3 } });

    const change = await api().patch(`/api/v1/cart/items/${ids.cable}`).set(bearer(token)).set(withCsrf).send({ qty: 2 });
    expect(change.body.cart.itemCount).toBe(2);

    await addToCart(token, ids.phone);
    // The store is suspended and the cable sells out elsewhere: both lines stay, flagged, and checkout is blocked.
    await Vendor.updateOne({ _id: vikram.storeId }, { status: "suspended" });
    await Product.updateOne({ _id: ids.cable }, { stock: 1 });
    const cart = await api().get("/api/v1/cart").set(bearer(token));
    const problems = Object.fromEntries(
      cart.body.cart.groups.flatMap((g: { items: { title: string; problem: string }[] }) => g.items.map((i) => [i.title, i.problem])),
    );
    expect(problems).toEqual({ "Galaxy Phone": "unavailable", "USB-C Cable": "not_enough_stock" });
    expect(cart.body.cart).toMatchObject({ canCheckout: false, problems: 2 });

    const unavailable = await addToCart(token, ids.case_);
    expect(unavailable.status).toBe(404);

    const removed = await api().delete(`/api/v1/cart/items/${ids.phone}`).set(bearer(token)).set(withCsrf);
    expect(removed.body.cart.groups).toHaveLength(1);
  });
});

describe("checkout", () => {
  it("turns a cart from two stores into one order with two parts and reserves the stock", async () => {
    const { ids } = await shop();
    const { token, addressId } = await customer();
    await addToCart(token, ids.phone, 1);
    await addToCart(token, ids.case_, 2);
    await addToCart(token, ids.cable, 2);

    const res = await checkout(token, addressId, { expectedTotal: 2_000_000 + 2 * 49_900 + 2 * 29_900 });
    expect(res.status).toBe(201);
    const { order, payment } = res.body;
    expect(order.orderNumber).toMatch(/^SS-\d{4}-000001$/);
    expect(order).toMatchObject({ status: "pending_payment", itemsTotal: 2_159_600, grandTotal: 2_159_600 });
    expect(order.shippingAddress).toMatchObject({ name: "Priya Sharma", pincode: "560001" });
    expect(order.parts.map((p: { vendor: { storeName: string }; status: string }) => [p.vendor.storeName, p.status])).toEqual([
      ["Vikram Electronics", "awaiting_payment"],
      ["Meera Gadgets", "awaiting_payment"],
    ]);
    expect(payment).toMatchObject({ provider: "mock", amount: 2_159_600, currency: "INR" });
    expect(payment.providerOrderId).toMatch(/^order_mock_/);

    // Stock is taken now, not at payment, and the cart is empty.
    expect([await stockOf(ids.phone), await stockOf(ids.case_), await stockOf(ids.cable)]).toEqual([4, 18, 1]);
    expect((await api().get("/api/v1/cart").set(bearer(token))).body.cart.itemCount).toBe(0);

    // Commission is frozen per line: phones 15%, cables fall back to the department's 5%.
    const parts = await SubOrder.find({ orderId: order.id }).sort({ _id: 1 });
    expect(parts.map((p) => [p.itemsTotal, p.commission, p.vendorNet])).toEqual([
      [2_099_800, 314_970, 1_784_830],
      [59_800, 2_990, 56_810],
    ]);
  });

  it("refuses an empty cart, a stale total, a missing address and non-customers", async () => {
    const { ids, vikram } = await shop();
    const { token, addressId } = await customer();
    expect((await checkout(token, addressId)).body.error.code).toBe("cart_empty");

    await addToCart(token, ids.phone);
    await Product.updateOne({ _id: ids.phone }, { price: 2_100_000 });
    const stale = await checkout(token, addressId, { expectedTotal: 2_000_000 });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: "price_changed", details: { itemsTotal: 2_100_000 } });

    const noAddress = await checkout(token, "0123456789abcdef01234567");
    expect(noAddress.body.error.details.fields[0].field).toBe("addressId");

    const asVendor = await api().post("/api/v1/checkout").set(bearer(vikram.token)).send({ addressId });
    expect(asVendor.status).toBe(403);
  });

  it("never oversells when many shoppers race for the last units", async () => {
    const { ids } = await shop();
    // 3 cables in stock, 6 shoppers each with 1 in the cart, all pressing "Place order" at once.
    const shoppers = await Promise.all(Array.from({ length: 6 }, (_, i) => customer(`racer${i}@example.com`)));
    for (const s of shoppers) await addToCart(s.token, ids.cable, 1);

    const results = await Promise.all(shoppers.map((s) => checkout(s.token, s.addressId)));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(3);
    expect(statuses.filter((s) => s === 409)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === "out_of_stock")).toBe(true);
    expect(await stockOf(ids.cable)).toBe(0);
    expect(await Order.countDocuments()).toBe(3);
  });
});

describe("payment and reservations", () => {
  it("confirms the order once the signed payment is verified, and only once", async () => {
    const { ids } = await shop();
    const { token, addressId } = await customer();
    await addToCart(token, ids.phone);
    await addToCart(token, ids.cable);
    const { order, payment } = (await checkout(token, addressId)).body;

    const forged = await api()
      .post("/api/v1/checkout/verify")
      .set(bearer(token))
      .send({ orderId: order.id, providerOrderId: payment.providerOrderId, providerPaymentId: "pay_mock_fake", signature: "0".repeat(64) });
    expect(forged.status).toBe(400);
    expect(forged.body.error.code).toBe("invalid_signature");

    const declined = await api().post("/api/v1/payments/mock/pay").set(bearer(token)).send({ providerOrderId: payment.providerOrderId, outcome: "failure" });
    expect(declined.status).toBe(402);

    const gateway = await api().post("/api/v1/payments/mock/pay").set(bearer(token)).send({ providerOrderId: payment.providerOrderId });
    const proof = { orderId: order.id, providerOrderId: payment.providerOrderId, ...gateway.body };
    const paid = await api().post("/api/v1/checkout/verify").set(bearer(token)).send(proof);
    expect(paid.status).toBe(200);
    expect(paid.body.order).toMatchObject({ status: "confirmed", payment: { status: "paid", providerOrderId: null } });
    expect(paid.body.order.parts.map((p: { status: string }) => p.status)).toEqual(["placed", "placed"]);
    expect((await Product.findById(ids.phone))!.soldCount).toBe(1);

    // The same proof again (a double click, or the webhook on Day 6) changes nothing.
    const again = await api().post("/api/v1/checkout/verify").set(bearer(token)).send(proof);
    expect(again.status).toBe(200);
    expect((await Product.findById(ids.phone))!.soldCount).toBe(1);

    // Another customer can't see or pay this order.
    const other = await customer("someone@example.com");
    expect((await api().get(`/api/v1/orders/${order.id}`).set(bearer(other.token))).status).toBe(404);
  });

  it("gives the stock back when an order isn't paid in time, and then refuses payment", async () => {
    const { ids } = await shop();
    const { token, addressId } = await customer();
    await addToCart(token, ids.cable, 2);
    const { order, payment } = (await checkout(token, addressId)).body;
    expect(await stockOf(ids.cable)).toBe(1);

    // Not due yet: the expiry job does nothing.
    const deps = { redis, searchSync, reservations: noReservations };
    expect(await releaseReservation(deps, order.id, { to: "expired", reason: "Not paid in time", actor: { role: "system" }, onlyIfDue: true })).toBe(false);

    await Order.updateOne({ _id: order.id }, { reservationExpiresAt: new Date(Date.now() - 1000) });
    expect(await expireDueOrders(deps)).toBe(1);
    expect(await expireDueOrders(deps)).toBe(0);
    expect(await stockOf(ids.cable)).toBe(3);

    const view = await api().get(`/api/v1/orders/${order.id}`).set(bearer(token));
    expect(view.body.order.status).toBe("expired");
    expect(view.body.order.parts[0]).toMatchObject({ status: "cancelled", cancelReason: "Not paid in time" });
    expect(view.body.payment).toBeNull();

    const late = await api().post("/api/v1/payments/mock/pay").set(bearer(token)).send({ providerOrderId: payment.providerOrderId });
    expect(late.body.error.code).toBe("order_not_payable");
  });

  it("lets the customer cancel an unpaid order, returning its stock at once", async () => {
    const { ids } = await shop();
    const { token, addressId } = await customer();
    await addToCart(token, ids.phone, 2);
    const { order } = (await checkout(token, addressId)).body;
    const cancelled = await api().post(`/api/v1/orders/${order.id}/cancel`).set(bearer(token));
    expect(cancelled.body.order.status).toBe("cancelled");
    expect(await stockOf(ids.phone)).toBe(5);
    expect((await api().post(`/api/v1/orders/${order.id}/cancel`).set(bearer(token))).status).toBe(409);
  });
});

describe("after payment", () => {
  async function paidOrder() {
    const s = await shop();
    const c = await customer();
    await addToCart(c.token, s.ids.phone);
    await addToCart(c.token, s.ids.cable, 2);
    const { order, payment } = (await checkout(c.token, c.addressId)).body;
    await pay(c.token, order.id, payment.providerOrderId);
    const parts = (await api().get(`/api/v1/orders/${order.id}`).set(bearer(c.token))).body.order.parts as { id: string }[];
    return { ...s, ...c, orderId: order.id as string, vikramPart: parts[0]!.id, meeraPart: parts[1]!.id };
  }

  const move = (token: string, subId: string, body: Record<string, unknown>) =>
    api().post(`/api/v1/vendor/orders/${subId}/status`).set(bearer(token)).send(body);

  it("shows each vendor only their own paid parts", async () => {
    const s = await shop();
    const c = await customer();
    await addToCart(c.token, s.ids.phone);
    const { order, payment } = (await checkout(c.token, c.addressId)).body;
    expect((await api().get("/api/v1/vendor/orders").set(bearer(s.vikram.token))).body.total).toBe(0);

    await pay(c.token, order.id, payment.providerOrderId);
    const list = await api().get("/api/v1/vendor/orders").set(bearer(s.vikram.token));
    expect(list.body.total).toBe(1);
    expect(list.body.items[0]).toMatchObject({
      status: "placed",
      nextStatus: "packed",
      customer: { name: "Priya Sharma" },
      shippingAddress: { city: "Bengaluru" },
      itemsTotal: 2_000_000,
      commission: 300_000,
      vendorNet: 1_700_000,
    });
    expect(list.body.counts).toMatchObject({ placed: 1, packed: 0 });
    expect((await api().get("/api/v1/vendor/orders").set(bearer(s.meera.token))).body.total).toBe(0);
  });

  it("moves a part one step at a time, needs tracking to ship, and completes the order", async () => {
    const o = await paidOrder();
    const skip = await move(o.vikram.token, o.vikramPart, { status: "delivered" });
    expect(skip.status).toBe(409);
    expect(skip.body.error).toMatchObject({ code: "invalid_transition", details: { from: "placed", allowed: ["packed"] } });

    expect((await move(o.meera.token, o.vikramPart, { status: "packed" })).status).toBe(404);
    expect((await move(o.vikram.token, o.vikramPart, { status: "packed" })).body.part.status).toBe("packed");
    expect((await move(o.vikram.token, o.vikramPart, { status: "shipped" })).status).toBe(400);
    const shipped = await move(o.vikram.token, o.vikramPart, { status: "shipped", tracking: { carrier: "Delhivery", number: "DL123456" } });
    expect(shipped.body.part).toMatchObject({ status: "shipped", tracking: { carrier: "Delhivery", number: "DL123456" } });
    await move(o.vikram.token, o.vikramPart, { status: "delivered" });

    // One part delivered, one still placed: the order stays confirmed until the customer cancels the other.
    let view = (await api().get(`/api/v1/orders/${o.orderId}`).set(bearer(o.token))).body.order;
    expect(view.status).toBe("confirmed");
    expect(view.parts[0].timeline.map((t: { status: string }) => t.status)).toEqual(["awaiting_payment", "placed", "packed", "shipped", "delivered"]);
    expect(view.parts[0].canCancel).toBe(false);

    const cancelled = await api().post(`/api/v1/orders/${o.orderId}/sub-orders/${o.meeraPart}/cancel`).set(bearer(o.token)).send({ reason: "Ordered by mistake" });
    expect(cancelled.status).toBe(200);
    view = cancelled.body.order;
    expect(view.status).toBe("completed");
    expect(view.parts[1]).toMatchObject({ status: "cancelled", cancelReason: "Ordered by mistake" });
    expect(await stockOf(o.ids.cable)).toBe(3);
  });

  it("stops the customer cancelling a part that has shipped, and a vendor moving a cancelled one", async () => {
    const o = await paidOrder();
    await move(o.vikram.token, o.vikramPart, { status: "packed" });
    await move(o.vikram.token, o.vikramPart, { status: "shipped", tracking: { carrier: "BlueDart", number: "BD99887766" } });
    const late = await api().post(`/api/v1/orders/${o.orderId}/sub-orders/${o.vikramPart}/cancel`).set(bearer(o.token)).send({});
    expect(late.status).toBe(409);
    expect(late.body.error.details.from).toBe("shipped");

    await api().post(`/api/v1/orders/${o.orderId}/sub-orders/${o.meeraPart}/cancel`).set(bearer(o.token)).send({});
    expect((await move(o.meera.token, o.meeraPart, { status: "packed" })).status).toBe(409);
  });

  it("lists the customer's orders newest first, and keeps ordered products from being deleted", async () => {
    const o = await paidOrder();
    const list = await api().get("/api/v1/orders").set(bearer(o.token));
    expect(list.body.items[0]).toMatchObject({ status: "confirmed", itemCount: 3, title: "Galaxy Phone and 1 more" });
    expect(list.body.items[0].parts).toHaveLength(2);

    const del = await api().delete(`/api/v1/vendor/products/${o.ids.phone}`).set(bearer(o.vikram.token));
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("product_has_orders");
  });
});
