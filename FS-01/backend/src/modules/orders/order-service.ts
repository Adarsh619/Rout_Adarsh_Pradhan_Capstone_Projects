import type { Redis } from "ioredis";
import type { ClientSession, Types } from "mongoose";
import { cacheKeys, invalidate } from "../../lib/cache.js";
import { logger } from "../../lib/logger.js";
import { inTransaction } from "../../lib/transaction.js";
import { AppError } from "../../middleware/errors.js";
import { CartStore, userCartKey } from "../cart/cart-store.js";
import { Product } from "../catalog/product.model.js";
import { applyCoupon } from "../coupons/coupon-rules.js";
import { couponKeyFor, evaluateCoupon, redeem, releaseRedemption, termsOf } from "../coupons/coupon-service.js";
import type { CouponDoc } from "../coupons/coupon.model.js";
import type { InvoiceJobs } from "../invoices/invoice-jobs.js";
import { record, type LedgerInput } from "../payments/ledger.model.js";
import { addRefundToOrder, type MoneyJobs } from "../payments/money-jobs.js";
import type { PaymentProvider } from "../payments/payment-provider.js";
import type { SearchSync } from "../search/search-sync.js";
import { User } from "../users/user.model.js";
import { Order, SubOrder, nextOrderNumber, type ActorRole, type OrderDoc, type SubOrderDoc, type SubOrderStatus } from "./order.model.js";
import { canAdminCancel, canCustomerCancel, canVendorMove, rollUpOrderStatus, splitByVendor, VENDOR_NEXT } from "./order-rules.js";
import { priceLines } from "./pricing.js";
import type { ReservationScheduler } from "./reservations.js";

export interface OrderDeps {
  redis: Redis;
  searchSync: SearchSync;
  payments: PaymentProvider;
  reservations: ReservationScheduler;
  reservationMinutes: number;
  // Refunds and payouts, run in the background.
  moneyJobs: MoneyJobs;
  // Invoice PDFs, made in the background once an order is paid.
  invoiceJobs: InvoiceJobs;
}

export interface Actor {
  userId?: string;
  role: ActorRole;
}

const SYSTEM: Actor = { role: "system" };

const history = (status: SubOrderStatus, actor: Actor, note?: string) => ({
  status,
  at: new Date(),
  byRole: actor.role,
  ...(actor.userId && { byUserId: actor.userId }),
  ...(note && { note }),
});

// Stock changed: product pages and search must show it (in stock / out of stock).
export async function afterStockChange(deps: Pick<OrderDeps, "redis" | "searchSync">, productIds: (string | Types.ObjectId)[]) {
  const ids = [...new Set(productIds.map(String))];
  await invalidate(deps.redis, ...ids.map(cacheKeys.product));
  await Promise.all(ids.map((id) => deps.searchSync.product(id)));
}

// ---- Checkout --------------------------------------------------------------------------------------

export async function placeOrder(deps: OrderDeps, input: { userId: string; addressId: string; expectedTotal?: number }) {
  const cart = new CartStore(deps.redis);
  const cartKey = userCartKey(input.userId);
  // Oldest first, so the order lists things in the order they were added.
  const lines = (await cart.read(cartKey)).reverse();
  if (lines.length === 0) throw new AppError(409, "cart_empty", "Your cart is empty");

  const user = await User.findById(input.userId);
  const address = user?.addresses.id(input.addressId);
  if (!user || !address) {
    throw new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field: "addressId", message: "Choose a delivery address" }] });
  }

  // Today's prices and stock, never what the browser last saw.
  const { priced, problems, vendorById } = await priceLines(lines);
  if (problems.length) {
    throw new AppError(409, "cart_changed", "Some items in your cart changed. Review your cart and try again.", { items: problems });
  }

  const plainParts = splitByVendor(priced);
  const itemsTotal = plainParts.reduce((sum, p) => sum + p.itemsTotal, 0);

  // The coupon applied in the cart, checked again now (it may have expired or been used up since).
  const couponCode = await deps.redis.get(couponKeyFor(cartKey));
  let coupon: CouponDoc | null = null;
  if (couponCode) {
    const checked = await evaluateCoupon(couponCode, input.userId, plainParts);
    if (checked.problem || !checked.coupon) throw new AppError(409, "coupon_invalid", `${checked.problem} Remove the coupon to continue.`, { code: couponCode });
    coupon = checked.coupon;
  }
  const { parts, discount } = applyCoupon(plainParts, coupon ? termsOf(coupon) : null);
  const grandTotal = itemsTotal - discount;
  if (input.expectedTotal !== undefined && input.expectedTotal !== grandTotal) {
    throw new AppError(409, "price_changed", "Prices changed since you opened checkout. Check the new total.", {
      expectedTotal: input.expectedTotal,
      itemsTotal,
      discount,
      grandTotal,
    });
  }

  const orderNumber = await nextOrderNumber();
  const expiresAt = new Date(Date.now() + deps.reservationMinutes * 60_000);

  const order = await inTransaction(async (session) => {
    // Take the stock only if enough is still there. Two shoppers racing for the last unit: one update matches,
    // the other matches nothing (or hits a write conflict and is retried), so stock never goes below zero.
    for (const line of priced) {
      const taken = await Product.updateOne(
        { _id: line.productId, status: "active", stock: { $gte: line.qty } },
        { $inc: { stock: -line.qty } },
        { session },
      );
      if (taken.modifiedCount !== 1) {
        throw new AppError(409, "out_of_stock", `${line.title} sold out while you were checking out`, { productId: line.productId });
      }
    }
    const [created] = await Order.create(
      [
        {
          orderNumber,
          customerId: user._id,
          items: priced,
          shippingAddress: { name: address.name, phone: address.phone, line1: address.line1, line2: address.line2, city: address.city, state: address.state, pincode: address.pincode },
          itemsTotal,
          discount,
          grandTotal,
          ...(coupon && {
            coupon: { couponId: coupon._id, code: coupon.code, scope: coupon.scope, vendorId: coupon.vendorId, discount },
          }),
          payment: { provider: deps.payments.name, status: "created" },
          status: "pending_payment",
          reservationExpiresAt: expiresAt,
        },
      ],
      { session },
    );
    await SubOrder.create(
      parts.map((part) => {
        const vendor = vendorById.get(part.vendorId)!;
        return {
          orderId: created!._id,
          orderNumber,
          customerId: user._id,
          vendorId: part.vendorId,
          vendorName: vendor.storeName,
          vendorSlug: vendor.slug,
          items: part.items,
          itemsTotal: part.itemsTotal,
          discountShare: part.discountShare,
          ...(part.discountBy && { discountBy: part.discountBy }),
          payable: part.payable,
          commission: part.commission,
          vendorNet: part.vendorNet,
          status: "awaiting_payment",
          statusHistory: [history("awaiting_payment", { userId: input.userId, role: "customer" }, "Order placed, waiting for payment")],
        };
      }),
      { session, ordered: true },
    );
    if (coupon) await redeem(coupon, input.userId, created!._id, session);
    return created!;
  });

  // The payment provider is called after the stock is safely reserved. If it can't be reached, the stock goes
  // straight back and the shopper can try again; nothing was charged.
  try {
    const { providerOrderId } = await deps.payments.createOrder({ amount: grandTotal, receipt: orderNumber });
    order.set("payment.providerOrderId", providerOrderId);
    await order.save();
  } catch (err) {
    await releaseReservation(deps, order.id as string, { to: "cancelled", reason: "The payment service couldn't be reached", actor: SYSTEM });
    if (err instanceof AppError) throw err;
    throw new AppError(502, "payment_unavailable", "Payments are unavailable right now. Nothing was charged; please try again.");
  }

  await deps.reservations.schedule(order.id as string, expiresAt);
  await cart.remove(cartKey, ...priced.map((l) => l.productId));
  await deps.redis.del(couponKeyFor(cartKey));
  await afterStockChange(deps, priced.map((l) => l.productId));
  return order;
}

// ---- Payment ---------------------------------------------------------------------------------------

// Confirms an order once its payment is proven, and puts each vendor's share on hold until delivery. Safe to call
// twice for the same payment (the popup's callback and Razorpay's webhook both report it).
export async function markPaid(deps: Pick<OrderDeps, "payments" | "reservations" | "invoiceJobs">, orderId: string, providerPaymentId: string): Promise<OrderDoc> {
  const now = new Date();
  const paid = await inTransaction(async (session) => {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: "pending_payment" },
      { $set: { status: "confirmed", "payment.status": "paid", "payment.providerPaymentId": providerPaymentId, "payment.paidAt": now } },
      { session, returnDocument: "after" },
    );
    if (!order) return undefined;
    const parts = await SubOrder.find({ orderId: order._id, status: "awaiting_payment" }).session(session);
    const entries: LedgerInput[] = [{ type: "payment", orderId: order._id, amount: order.grandTotal, providerRef: providerPaymentId }];
    // A platform coupon: the platform covers that part of the price, so vendors are still owed their full share.
    if (order.coupon?.scope === "platform" && order.discount > 0) {
      entries.push({ type: "platform_discount", orderId: order._id, amount: order.discount, note: `Coupon ${order.coupon.code}` });
    }
    for (const part of parts) {
      part.status = "placed";
      part.placedAt = now;
      part.statusHistory.push(history("placed", SYSTEM, "Payment received"));
      // Escrow: the vendor's share is owed but held by the platform until the part is delivered.
      part.set("payout", { amount: part.vendorNet, status: "held" });
      await part.save({ session });
      entries.push(
        { type: "commission", orderId: order._id, subOrderId: part._id, vendorId: part.vendorId, amount: part.commission },
        { type: "vendor_hold", orderId: order._id, subOrderId: part._id, vendorId: part.vendorId, amount: part.vendorNet },
      );
    }
    await record(entries, session);
    await Product.bulkWrite(
      order.items.map((item) => ({ updateOne: { filter: { _id: item.productId }, update: { $inc: { soldCount: item.qty } } } })),
      { session },
    );
    return order;
  });
  if (paid) {
    await deps.reservations.cancel(orderId);
    for (const part of await SubOrder.find({ orderId: paid._id }).select("_id")) await deps.invoiceJobs.generate(part.id as string);
    return paid;
  }

  const order = await Order.findById(orderId);
  if (order && order.payment?.providerPaymentId === providerPaymentId && order.payment.status !== "created" && order.payment.status !== "failed") return order;
  // Paid after the reservation ran out: the stock may already be sold to someone else, so the money goes straight back.
  if (order) await refundLatePayment(deps, order, providerPaymentId);
  throw new AppError(409, "order_not_payable", "This order expired or was cancelled before the payment arrived, so its items went back on sale. The payment has been refunded in full.");
}

// A payment for an order that already ended (expired or cancelled before paying) is refunded in full, once.
export async function refundLatePayment(deps: Pick<OrderDeps, "payments">, order: OrderDoc, providerPaymentId: string): Promise<void> {
  if (order.status !== "expired" && order.status !== "cancelled") return;
  // Claim it first, so two reports of the same payment (popup and webhook) don't both refund.
  const claimed = await Order.findOneAndUpdate(
    { _id: order._id, "payment.providerPaymentId": { $exists: false } },
    { $set: { "payment.providerPaymentId": providerPaymentId, "payment.status": "paid", "payment.paidAt": new Date() } },
    { returnDocument: "after" },
  );
  if (!claimed) return;
  try {
    const refund = await deps.payments.refund({ providerPaymentId, amount: order.grandTotal, key: `late-${order.id as string}` });
    await inTransaction(async (session) => {
      await record(
        [
          { type: "payment", orderId: order._id, amount: order.grandTotal, providerRef: providerPaymentId, note: "Paid after the order ended" },
          { type: "refund", orderId: order._id, amount: order.grandTotal, providerRef: refund.refundId, note: "Late payment refunded in full" },
        ],
        session,
      );
      await addRefundToOrder(order._id, order.grandTotal, session);
    });
  } catch (err) {
    // Stays visible as paid on an ended order, for an admin to refund by hand (Day 8 admin refunds page).
    logger.error({ err, orderId: order.id, providerPaymentId }, "could not refund a late payment");
  }
}

// ---- Giving reserved stock back ------------------------------------------------------------------

// Ends an unpaid order: its stock goes back on sale and every part is cancelled. Does nothing if the order was
// paid (or already ended) in the meantime, so the expiry job, the sweep and the customer can all call it safely.
export async function releaseReservation(
  deps: Pick<OrderDeps, "redis" | "searchSync" | "reservations">,
  orderId: string,
  opts: { to: "expired" | "cancelled"; reason: string; actor: Actor; onlyIfDue?: boolean },
): Promise<boolean> {
  const now = new Date();
  const released = await inTransaction(async (session) => {
    const order = await Order.findOneAndUpdate(
      { _id: orderId, status: "pending_payment", ...(opts.onlyIfDue && { reservationExpiresAt: { $lte: now } }) },
      { $set: { status: opts.to, cancelledAt: now } },
      { session, returnDocument: "after" },
    );
    if (!order) return undefined;
    await Product.bulkWrite(
      order.items.map((item) => ({ updateOne: { filter: { _id: item.productId }, update: { $inc: { stock: item.qty } } } })),
      { session },
    );
    await SubOrder.updateMany(
      { orderId: order._id, status: "awaiting_payment" },
      { $set: { status: "cancelled", cancelledAt: now, cancelReason: opts.reason }, $push: { statusHistory: history("cancelled", opts.actor, opts.reason) } },
      { session },
    );
    // Never paid, so the coupon use is given back.
    if (order.coupon?.couponId) await releaseRedemption(order.coupon.couponId, order._id, session);
    return order.items.map((i) => i.productId);
  });
  if (!released) return false;
  await deps.reservations.cancel(orderId);
  await afterStockChange(deps, released);
  return true;
}

// The minute sweep: every unpaid order past its time.
export async function expireDueOrders(deps: Pick<OrderDeps, "redis" | "searchSync" | "reservations">): Promise<number> {
  const due = await Order.find({ status: "pending_payment", reservationExpiresAt: { $lte: new Date() } })
    .select("_id")
    .limit(200);
  let n = 0;
  for (const order of due) {
    if (await releaseReservation(deps, order.id as string, { to: "expired", reason: "Not paid in time", actor: SYSTEM, onlyIfDue: true })) n++;
  }
  return n;
}

// ---- After payment: cancelling and fulfilment ------------------------------------------------------

// Re-reads every part and sets the order's overall status.
async function rollUp(orderId: Types.ObjectId, session: ClientSession) {
  const parts = await SubOrder.find({ orderId }).select("status").session(session);
  const status = rollUpOrderStatus(parts.map((p) => p.status as SubOrderStatus));
  const now = new Date();
  await Order.updateOne(
    { _id: orderId, status: { $in: ["confirmed", "completed", "cancelled"] } },
    { $set: { status, ...(status === "completed" && { completedAt: now }), ...(status === "cancelled" && { cancelledAt: now }) } },
    { session },
  );
}

// The customer cancels one store's part before it ships: its stock goes back on sale, the vendor's held share and
// the platform's commission are reversed, and what the customer paid for it is refunded through the payment provider.
export async function cancelPart(
  deps: Pick<OrderDeps, "redis" | "searchSync" | "moneyJobs">,
  input: { orderId?: string; subOrderId: string; actor: Actor & { userId: string }; reason?: string },
): Promise<SubOrderDoc> {
  const admin = input.actor.role === "admin";
  // A customer can only reach their own parts; an admin any part.
  const sub = await SubOrder.findOne({ _id: input.subOrderId, ...(input.orderId && { orderId: input.orderId }), ...(!admin && { customerId: input.actor.userId }) });
  if (!sub) throw new AppError(404, "not_found", "Order not found");
  const from = sub.status as SubOrderStatus;
  if (!(admin ? canAdminCancel(from) : canCustomerCancel(from))) {
    throw new AppError(409, "invalid_transition", from === "awaiting_payment" ? "This order isn't paid yet; cancel the whole order instead" : `This part is already ${from} and can't be cancelled`, { from });
  }
  const reason = input.reason || (admin ? "Cancelled and refunded by ShopSphere support" : "Cancelled by the customer");
  const now = new Date();
  const updated = await inTransaction(async (session) => {
    const doc = await SubOrder.findOneAndUpdate(
      { _id: sub._id, status: from },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          cancelReason: reason,
          "payout.status": "reversed",
          refund: { amount: sub.payable, status: "pending", requestedAt: now },
        },
        $push: { statusHistory: history("cancelled", input.actor, reason) },
      },
      { session, returnDocument: "after" },
    );
    if (!doc) return undefined;
    await record(
      [
        { type: "vendor_reversal", orderId: doc.orderId, subOrderId: doc._id, vendorId: doc.vendorId, amount: doc.vendorNet },
        { type: "commission_reversal", orderId: doc.orderId, subOrderId: doc._id, vendorId: doc.vendorId, amount: doc.commission },
        ...(doc.discountBy === "platform" && doc.discountShare > 0
          ? [{ type: "platform_discount_reversal" as const, orderId: doc.orderId, subOrderId: doc._id, vendorId: doc.vendorId, amount: doc.discountShare }]
          : []),
      ],
      session,
    );
    await Product.bulkWrite(
      doc.items.map((item) => ({ updateOne: { filter: { _id: item.productId }, update: { $inc: { stock: item.qty, soldCount: -item.qty } } } })),
      { session },
    );
    await rollUp(doc.orderId, session);
    return doc;
  });
  // The vendor changed it at the same moment (e.g. shipped it).
  if (!updated) throw new AppError(409, "invalid_transition", "This part changed while you were cancelling it. Refresh and try again.");
  await afterStockChange(deps, updated.items.map((i) => i.productId));
  await deps.moneyJobs.refund(updated.id as string);
  return updated;
}

// The vendor moves their part along: placed → packed → shipped (with tracking) → delivered. Delivery releases the
// vendor's held share, and a background job pays it out.
export async function advancePart(deps: Pick<OrderDeps, "moneyJobs">, input: {
  vendorId: string;
  subOrderId: string;
  to: SubOrderStatus;
  tracking?: { carrier: string; number: string };
  actor: Actor;
}): Promise<SubOrderDoc> {
  const sub = await SubOrder.findOne({ _id: input.subOrderId, vendorId: input.vendorId, placedAt: { $exists: true } });
  if (!sub) throw new AppError(404, "not_found", "Order not found");
  const from = sub.status as SubOrderStatus;
  if (!canVendorMove(from, input.to)) {
    const next = VENDOR_NEXT[from];
    throw new AppError(409, "invalid_transition", next ? `This order is ${from}; the next step is ${next}` : `This order is ${from} and can't change any more`, {
      from,
      to: input.to,
      allowed: next ? [next] : [],
    });
  }
  if (input.to === "shipped" && !input.tracking) {
    throw new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field: "tracking.number", message: "Add the courier and tracking number" }] });
  }
  const now = new Date();
  const updated = await inTransaction(async (session) => {
    const doc = await SubOrder.findOneAndUpdate(
      { _id: sub._id, status: from },
      {
        $set: {
          status: input.to,
          ...(input.tracking && { tracking: input.tracking }),
          ...(input.to === "delivered" && { deliveredAt: now, "payout.status": "released", "payout.releasedAt": now }),
        },
        $push: { statusHistory: history(input.to, input.actor, input.tracking ? `${input.tracking.carrier} ${input.tracking.number}` : undefined) },
      },
      { session, returnDocument: "after" },
    );
    if (doc && input.to === "delivered") {
      await record([{ type: "vendor_release", orderId: doc.orderId, subOrderId: doc._id, vendorId: doc.vendorId, amount: doc.vendorNet }], session);
      await rollUp(doc.orderId, session);
    }
    return doc;
  });
  if (!updated) throw new AppError(409, "invalid_transition", "This order changed in the meantime (the customer may have cancelled it). Refresh and try again.");
  if (input.to === "delivered") await deps.moneyJobs.payout(updated.id as string);
  return updated;
}
