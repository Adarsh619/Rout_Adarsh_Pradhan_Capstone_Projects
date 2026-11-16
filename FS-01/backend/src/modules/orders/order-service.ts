import type { Redis } from "ioredis";
import { cacheKeys, invalidate } from "../../lib/cache.js";
import { prisma, type Tx } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { inTransaction } from "../../lib/transaction.js";
import { AppError } from "../../middleware/errors.js";
import { CartStore, userCartKey } from "../cart/cart-store.js";
import { applyCoupon } from "../coupons/coupon-rules.js";
import { couponKeyFor, evaluateCoupon, redeem, releaseRedemption, termsOf } from "../coupons/coupon-service.js";
import type { CouponRow } from "../coupons/coupon.model.js";
import type { InvoiceJobs } from "../invoices/invoice-jobs.js";
import { record, type LedgerInput } from "../payments/ledger.model.js";
import { addRefundToOrder, type MoneyJobs } from "../payments/money-jobs.js";
import type { PaymentProvider } from "../payments/payment-provider.js";
import type { SearchSync } from "../search/search-sync.js";
import {
  nextOrderNumber,
  orderInclude,
  subOrderInclude,
  type ActorRole,
  type OrderLine,
  type OrderRow,
  type ShippingAddress,
  type SubOrderRow,
  type SubOrderStatus,
} from "./order.model.js";
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

// One row of a part's history: who moved it to which status, and when.
const event = (subOrderId: string, status: SubOrderStatus, actor: Actor, note?: string) => ({
  subOrderId,
  status,
  at: new Date(),
  byRole: actor.role,
  byUserId: actor.userId ?? null,
  note: note ?? null,
});

// Stock goes back (or soldCount moves) for every line, one product at a time, inside the caller's transaction.
async function addToProducts(tx: Tx, lines: Pick<OrderLine, "productId" | "qty">[], change: (qty: number) => { stock?: number; soldCount?: number }) {
  for (const line of lines) {
    const c = change(line.qty);
    await tx.product.updateMany({
      where: { id: line.productId },
      data: {
        ...(c.stock && { stock: { increment: c.stock } }),
        ...(c.soldCount && { soldCount: { increment: c.soldCount } }),
      },
    });
  }
}

// Stock changed: product pages and search must show it (in stock / out of stock).
export async function afterStockChange(deps: Pick<OrderDeps, "redis" | "searchSync">, productIds: string[]) {
  const ids = [...new Set(productIds)];
  await invalidate(deps.redis, ...ids.map(cacheKeys.product));
  await Promise.all(ids.map((id) => deps.searchSync.product(id)));
}

// ---- Checkout --------------------------------------------------------------------------------------

export async function placeOrder(deps: OrderDeps, input: { userId: string; addressId: string; expectedTotal?: number }): Promise<OrderRow> {
  const cart = new CartStore(deps.redis);
  const cartKey = userCartKey(input.userId);
  // Oldest first, so the order lists things in the order they were added.
  const lines = (await cart.read(cartKey)).reverse();
  if (lines.length === 0) throw new AppError(409, "cart_empty", "Your cart is empty");

  const address = await prisma.address.findFirst({ where: { id: input.addressId, userId: input.userId } });
  if (!address) {
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
  let coupon: CouponRow | null = null;
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
  const shippingAddress: ShippingAddress = {
    name: address.name,
    phone: address.phone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    pincode: address.pincode,
  };

  const order = await inTransaction(async (tx) => {
    // Take the stock only if enough is still there. Two shoppers racing for the last unit: the second update waits
    // for the first one's row lock, then matches nothing, so stock never goes below zero.
    for (const line of priced) {
      const taken = await tx.product.updateMany({
        where: { id: line.productId, status: "active", stock: { gte: line.qty } },
        data: { stock: { decrement: line.qty } },
      });
      if (taken.count !== 1) {
        throw new AppError(409, "out_of_stock", `${line.title} sold out while you were checking out`, { productId: line.productId });
      }
    }
    const created = await tx.order.create({
      data: {
        orderNumber,
        customerId: input.userId,
        shippingAddress: { ...shippingAddress },
        itemsTotal,
        discount,
        grandTotal,
        ...(coupon && { couponId: coupon.id, couponCode: coupon.code, couponScope: coupon.scope, couponVendorId: coupon.vendorId, couponDiscount: discount }),
        paymentProvider: deps.payments.name,
        paymentStatus: "created",
        status: "pending_payment",
        reservationExpiresAt: expiresAt,
      },
    });
    let position = 0;
    for (const part of parts) {
      const vendor = vendorById.get(part.vendorId)!;
      const sub = await tx.subOrder.create({
        data: {
          orderId: created.id,
          orderNumber,
          customerId: input.userId,
          vendorId: part.vendorId,
          vendorName: vendor.storeName,
          vendorSlug: vendor.slug,
          itemsTotal: part.itemsTotal,
          discountShare: part.discountShare,
          discountBy: part.discountBy ?? null,
          payable: part.payable,
          commission: part.commission,
          vendorNet: part.vendorNet,
          status: "awaiting_payment",
        },
      });
      await tx.orderLine.createMany({
        data: part.items.map((l) => ({
          orderId: created.id,
          subOrderId: sub.id,
          position: position++,
          productId: l.productId,
          vendorId: l.vendorId,
          title: l.title,
          imageKey: l.imageKey ?? null,
          price: l.price,
          qty: l.qty,
          commissionRateBp: l.commissionRateBp,
        })),
      });
      await tx.subOrderEvent.create({ data: event(sub.id, "awaiting_payment", { userId: input.userId, role: "customer" }, "Order placed, waiting for payment") });
    }
    if (coupon) await redeem(coupon, input.userId, created.id, tx);
    return created;
  });

  // The payment provider is called after the stock is safely reserved. If it can't be reached, the stock goes
  // straight back and the shopper can try again; nothing was charged.
  let withPayment: OrderRow;
  try {
    const { providerOrderId } = await deps.payments.createOrder({ amount: grandTotal, receipt: orderNumber });
    withPayment = await prisma.order.update({ where: { id: order.id }, data: { paymentProviderOrderId: providerOrderId }, include: orderInclude });
  } catch (err) {
    await releaseReservation(deps, order.id, { to: "cancelled", reason: "The payment service couldn't be reached", actor: SYSTEM });
    if (err instanceof AppError) throw err;
    throw new AppError(502, "payment_unavailable", "Payments are unavailable right now. Nothing was charged; please try again.");
  }

  await deps.reservations.schedule(order.id, expiresAt);
  await cart.remove(cartKey, ...priced.map((l) => l.productId));
  await deps.redis.del(couponKeyFor(cartKey));
  await afterStockChange(deps, priced.map((l) => l.productId));
  return withPayment;
}

// ---- Payment ---------------------------------------------------------------------------------------

// Confirms an order once its payment is proven, and puts each vendor's share on hold until delivery. Safe to call
// twice for the same payment (the popup's callback and Razorpay's webhook both report it).
export async function markPaid(deps: Pick<OrderDeps, "payments" | "reservations" | "invoiceJobs">, orderId: string, providerPaymentId: string): Promise<OrderRow> {
  const now = new Date();
  const paid = await inTransaction(async (tx) => {
    const [order] = await tx.order.updateManyAndReturn({
      where: { id: orderId, status: "pending_payment" },
      data: { status: "confirmed", paymentStatus: "paid", paymentProviderPaymentId: providerPaymentId, paidAt: now },
    });
    if (!order) return undefined;
    const parts = await tx.subOrder.findMany({ where: { orderId: order.id, status: "awaiting_payment" }, orderBy: { id: "asc" } });
    const entries: LedgerInput[] = [{ type: "payment", orderId: order.id, amount: order.grandTotal, providerRef: providerPaymentId }];
    // A platform coupon: the platform covers that part of the price, so vendors are still owed their full share.
    if (order.couponScope === "platform" && order.discount > 0) {
      entries.push({ type: "platform_discount", orderId: order.id, amount: order.discount, note: `Coupon ${order.couponCode}` });
    }
    for (const part of parts) {
      // Escrow: the vendor's share is owed but held by the platform until the part is delivered.
      await tx.subOrder.update({
        where: { id: part.id },
        data: { status: "placed", placedAt: now, payoutAmount: part.vendorNet, payoutStatus: "held" },
      });
      await tx.subOrderEvent.create({ data: event(part.id, "placed", SYSTEM, "Payment received") });
      entries.push(
        { type: "commission", orderId: order.id, subOrderId: part.id, vendorId: part.vendorId, amount: part.commission },
        { type: "vendor_hold", orderId: order.id, subOrderId: part.id, vendorId: part.vendorId, amount: part.vendorNet },
      );
    }
    await record(entries, tx);
    const lines = await tx.orderLine.findMany({ where: { orderId: order.id } });
    await addToProducts(tx, lines, (qty) => ({ soldCount: qty }));
    return order;
  });
  if (paid) {
    await deps.reservations.cancel(orderId);
    for (const part of await prisma.subOrder.findMany({ where: { orderId: paid.id }, select: { id: true } })) await deps.invoiceJobs.generate(part.id);
    return prisma.order.findUniqueOrThrow({ where: { id: paid.id }, include: orderInclude });
  }

  const order = await prisma.order.findUnique({ where: { id: orderId }, include: orderInclude });
  if (order && order.paymentProviderPaymentId === providerPaymentId && order.paymentStatus !== "created" && order.paymentStatus !== "failed") return order;
  // Paid after the reservation ran out: the stock may already be sold to someone else, so the money goes straight back.
  if (order) await refundLatePayment(deps, order, providerPaymentId);
  throw new AppError(409, "order_not_payable", "This order expired or was cancelled before the payment arrived, so its items went back on sale. The payment has been refunded in full.");
}

// A payment for an order that already ended (expired or cancelled before paying) is refunded in full, once.
export async function refundLatePayment(deps: Pick<OrderDeps, "payments">, order: Pick<OrderRow, "id" | "status" | "grandTotal">, providerPaymentId: string): Promise<void> {
  if (order.status !== "expired" && order.status !== "cancelled") return;
  // Claim it first, so two reports of the same payment (popup and webhook) don't both refund.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, paymentProviderPaymentId: null },
    data: { paymentProviderPaymentId: providerPaymentId, paymentStatus: "paid", paidAt: new Date() },
  });
  if (claimed.count !== 1) return;
  try {
    const refund = await deps.payments.refund({ providerPaymentId, amount: order.grandTotal, key: `late-${order.id}` });
    await inTransaction(async (tx) => {
      await record(
        [
          { type: "payment", orderId: order.id, amount: order.grandTotal, providerRef: providerPaymentId, note: "Paid after the order ended" },
          { type: "refund", orderId: order.id, amount: order.grandTotal, providerRef: refund.refundId, note: "Late payment refunded in full" },
        ],
        tx,
      );
      await addRefundToOrder(order.id, order.grandTotal, tx);
    });
  } catch (err) {
    // Stays visible as paid on an ended order, for an admin to refund by hand (admin refunds page).
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
  const released = await inTransaction(async (tx) => {
    const [order] = await tx.order.updateManyAndReturn({
      where: { id: orderId, status: "pending_payment", ...(opts.onlyIfDue && { reservationExpiresAt: { lte: now } }) },
      data: { status: opts.to, cancelledAt: now },
    });
    if (!order) return undefined;
    const lines = await tx.orderLine.findMany({ where: { orderId: order.id } });
    await addToProducts(tx, lines, (qty) => ({ stock: qty }));
    const parts = await tx.subOrder.updateManyAndReturn({
      where: { orderId: order.id, status: "awaiting_payment" },
      data: { status: "cancelled", cancelledAt: now, cancelReason: opts.reason },
      select: { id: true },
    });
    await tx.subOrderEvent.createMany({ data: parts.map((p) => event(p.id, "cancelled", opts.actor, opts.reason)) });
    // Never paid, so the coupon use is given back.
    if (order.couponId) await releaseRedemption(order.couponId, order.id, tx);
    return lines.map((l) => l.productId);
  });
  if (!released) return false;
  await deps.reservations.cancel(orderId);
  await afterStockChange(deps, released);
  return true;
}

// The minute sweep: every unpaid order past its time.
export async function expireDueOrders(deps: Pick<OrderDeps, "redis" | "searchSync" | "reservations">): Promise<number> {
  const due = await prisma.order.findMany({
    where: { status: "pending_payment", reservationExpiresAt: { lte: new Date() } },
    select: { id: true },
    take: 200,
  });
  let n = 0;
  for (const order of due) {
    if (await releaseReservation(deps, order.id, { to: "expired", reason: "Not paid in time", actor: SYSTEM, onlyIfDue: true })) n++;
  }
  return n;
}

// ---- After payment: cancelling and fulfilment ------------------------------------------------------

// Re-reads every part and sets the order's overall status.
async function rollUp(orderId: string, tx: Tx) {
  const parts = await tx.subOrder.findMany({ where: { orderId }, select: { status: true } });
  const status = rollUpOrderStatus(parts.map((p) => p.status));
  const now = new Date();
  await tx.order.updateMany({
    where: { id: orderId, status: { in: ["confirmed", "completed", "cancelled"] } },
    data: { status, ...(status === "completed" && { completedAt: now }), ...(status === "cancelled" && { cancelledAt: now }) },
  });
}

// The customer cancels one store's part before it ships: its stock goes back on sale, the vendor's held share and
// the platform's commission are reversed, and what the customer paid for it is refunded through the payment provider.
export async function cancelPart(
  deps: Pick<OrderDeps, "redis" | "searchSync" | "moneyJobs">,
  input: { orderId?: string; subOrderId: string; actor: Actor & { userId: string }; reason?: string },
): Promise<SubOrderRow> {
  const admin = input.actor.role === "admin";
  // A customer can only reach their own parts; an admin any part.
  const sub = await prisma.subOrder.findFirst({
    where: { id: input.subOrderId, ...(input.orderId && { orderId: input.orderId }), ...(!admin && { customerId: input.actor.userId }) },
  });
  if (!sub) throw new AppError(404, "not_found", "Order not found");
  const from = sub.status;
  if (!(admin ? canAdminCancel(from) : canCustomerCancel(from))) {
    throw new AppError(409, "invalid_transition", from === "awaiting_payment" ? "This order isn't paid yet; cancel the whole order instead" : `This part is already ${from} and can't be cancelled`, { from });
  }
  const reason = input.reason || (admin ? "Cancelled and refunded by ShopSphere support" : "Cancelled by the customer");
  const now = new Date();
  const updated = await inTransaction(async (tx) => {
    const [doc] = await tx.subOrder.updateManyAndReturn({
      where: { id: sub.id, status: from },
      data: {
        status: "cancelled",
        cancelledAt: now,
        cancelReason: reason,
        payoutStatus: "reversed",
        refundAmount: sub.payable,
        refundStatus: "pending",
        refundRequestedAt: now,
      },
    });
    if (!doc) return undefined;
    await tx.subOrderEvent.create({ data: event(doc.id, "cancelled", input.actor, reason) });
    await record(
      [
        { type: "vendor_reversal", orderId: doc.orderId, subOrderId: doc.id, vendorId: doc.vendorId, amount: doc.vendorNet },
        { type: "commission_reversal", orderId: doc.orderId, subOrderId: doc.id, vendorId: doc.vendorId, amount: doc.commission },
        ...(doc.discountBy === "platform" && doc.discountShare > 0
          ? [{ type: "platform_discount_reversal" as const, orderId: doc.orderId, subOrderId: doc.id, vendorId: doc.vendorId, amount: doc.discountShare }]
          : []),
      ],
      tx,
    );
    const lines = await tx.orderLine.findMany({ where: { subOrderId: doc.id } });
    await addToProducts(tx, lines, (qty) => ({ stock: qty, soldCount: -qty }));
    await rollUp(doc.orderId, tx);
    return tx.subOrder.findUniqueOrThrow({ where: { id: doc.id }, include: subOrderInclude });
  });
  // The vendor changed it at the same moment (e.g. shipped it).
  if (!updated) throw new AppError(409, "invalid_transition", "This part changed while you were cancelling it. Refresh and try again.");
  await afterStockChange(deps, updated.lines.map((l) => l.productId));
  await deps.moneyJobs.refund(updated.id);
  return updated;
}

// The vendor moves their part along: placed → packed → shipped (with tracking) → delivered. Delivery releases the
// vendor's held share, and a background job pays it out.
export async function advancePart(
  deps: Pick<OrderDeps, "moneyJobs">,
  input: {
    vendorId: string;
    subOrderId: string;
    to: SubOrderStatus;
    tracking?: { carrier: string; number: string };
    actor: Actor;
  },
): Promise<SubOrderRow> {
  const sub = await prisma.subOrder.findFirst({ where: { id: input.subOrderId, vendorId: input.vendorId, placedAt: { not: null } } });
  if (!sub) throw new AppError(404, "not_found", "Order not found");
  const from = sub.status;
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
  const updated = await inTransaction(async (tx) => {
    const [doc] = await tx.subOrder.updateManyAndReturn({
      where: { id: sub.id, status: from },
      data: {
        status: input.to,
        ...(input.tracking && { trackingCarrier: input.tracking.carrier, trackingNumber: input.tracking.number }),
        ...(input.to === "delivered" && { deliveredAt: now, payoutStatus: "released", payoutReleasedAt: now }),
      },
    });
    if (!doc) return undefined;
    await tx.subOrderEvent.create({ data: event(doc.id, input.to, input.actor, input.tracking ? `${input.tracking.carrier} ${input.tracking.number}` : undefined) });
    if (input.to === "delivered") {
      await record([{ type: "vendor_release", orderId: doc.orderId, subOrderId: doc.id, vendorId: doc.vendorId, amount: doc.vendorNet }], tx);
      await rollUp(doc.orderId, tx);
    }
    return tx.subOrder.findUniqueOrThrow({ where: { id: doc.id }, include: subOrderInclude });
  });
  if (!updated) throw new AppError(409, "invalid_transition", "This order changed in the meantime (the customer may have cancelled it). Refresh and try again.");
  if (input.to === "delivered") await deps.moneyJobs.payout(updated.id);
  return updated;
}
