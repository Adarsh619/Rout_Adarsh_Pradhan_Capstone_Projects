import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, objectId, pageQuery, parseQuery, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { MockPaymentProvider } from "../payments/payment-provider.js";
import { User } from "../users/user.model.js";
import { loadOwnStore } from "../vendors/vendor-access.js";
import { Order, SUB_ORDER_STATUSES, SubOrder, type OrderDoc } from "./order.model.js";
import { advancePart, cancelPart, markPaid, placeOrder, releaseReservation, type OrderDeps } from "./order-service.js";
import { toCustomerOrder, toOrderSummary, toVendorPart } from "./order-views.js";

const checkoutSchema = z.object({
  addressId: objectId,
  // The items total the shopper saw; if prices moved since, checkout stops and shows the new total.
  expectedTotal: z.number().int().min(0).optional(),
});

const verifySchema = z.object({
  orderId: objectId,
  providerOrderId: z.string().min(1).max(100),
  providerPaymentId: z.string().min(1).max(100),
  signature: z.string().min(1).max(200),
});

const mockPaySchema = z.object({
  providerOrderId: z.string().min(1).max(100),
  outcome: z.enum(["success", "failure"]).default("success"),
});

const cancelSchema = z.object({ reason: z.string().trim().max(300).optional() });

const statusSchema = z
  .object({
    status: z.enum(["packed", "shipped", "delivered"]),
    tracking: z
      .object({
        carrier: z.string().trim().min(2, "Enter the courier").max(60),
        number: z.string().trim().min(4, "Enter the tracking number").max(60),
      })
      .optional(),
  })
  .refine((b) => b.status !== "shipped" || b.tracking, { message: "Add the courier and tracking number", path: ["tracking", "number"] });

const vendorListQuery = pageQuery.extend({ status: z.enum(SUB_ORDER_STATUSES).exclude(["awaiting_payment"]).optional() });

export function orderRouter(ctx: RouteContext): Router {
  const router = Router();
  const deps: OrderDeps = {
    redis: ctx.redis,
    searchSync: ctx.searchSync,
    payments: ctx.payments,
    reservations: ctx.reservations,
    reservationMinutes: ctx.reservationMinutes,
    moneyJobs: ctx.moneyJobs,
  };
  const customer = [ctx.signedIn, requireRole("customer")];
  const seller = [ctx.signedIn, requireRole("vendor"), loadOwnStore({ approved: false })];

  const ownOrder = async (id: string, userId: string): Promise<OrderDoc> => {
    const order = await Order.findOne({ _id: id, customerId: userId });
    if (!order) throw new AppError(404, "not_found", "Order not found");
    return order;
  };
  const customerView = async (order: OrderDoc) => toCustomerOrder(order, await SubOrder.find({ orderId: order._id }).sort({ _id: 1 }), ctx.storage);

  // What the browser needs to open the payment screen for a waiting order.
  const paymentStep = (order: OrderDoc) => ({
    provider: ctx.payments.name,
    providerOrderId: order.payment!.providerOrderId!,
    amount: order.grandTotal,
    currency: "INR",
    expiresAt: order.reservationExpiresAt.toISOString(),
    ...ctx.payments.publicConfig(),
  });

  // ---- Checkout and payment -------------------------------------------------------------------

  router.post("/checkout", ...customer, validateBody(checkoutSchema), async (req, res) => {
    const body = req.body as z.infer<typeof checkoutSchema>;
    const order = await placeOrder(deps, { userId: req.auth!.id, addressId: body.addressId, expectedTotal: body.expectedTotal });
    res.status(201).json({ order: await customerView(order), payment: paymentStep(order) });
  });

  router.post("/checkout/verify", ...customer, validateBody(verifySchema), async (req, res) => {
    const body = req.body as z.infer<typeof verifySchema>;
    const order = await ownOrder(body.orderId, req.auth!.id);
    if (order.payment?.providerOrderId !== body.providerOrderId || !ctx.payments.verifyPayment(body)) {
      throw new AppError(400, "invalid_signature", "The payment couldn't be verified. If money left your account, it will be refunded.");
    }
    // A valid signature proves the payment was authorised; make sure the money is actually taken (captured).
    if (order.status === "pending_payment") {
      await ctx.payments.ensureCaptured({ providerOrderId: body.providerOrderId, providerPaymentId: body.providerPaymentId, amount: order.grandTotal });
    }
    res.json({ order: await customerView(await markPaid(deps, order.id as string, body.providerPaymentId)) });
  });

  // The test payment screen used with PAYMENT_PROVIDER=mock. It plays Razorpay's part: it "takes" the payment and
  // hands back a signed payment id, which the app then verifies through /checkout/verify like a real one.
  if (ctx.payments instanceof MockPaymentProvider) {
    const gateway = ctx.payments;
    router.post("/payments/mock/pay", ...customer, validateBody(mockPaySchema), async (req, res) => {
      const body = req.body as z.infer<typeof mockPaySchema>;
      const order = await Order.findOne({ "payment.providerOrderId": body.providerOrderId, customerId: req.auth!.id });
      if (!order) throw new AppError(404, "not_found", "Payment not found");
      if (order.status !== "pending_payment") {
        throw new AppError(409, "order_not_payable", "This order can no longer be paid. It expired or was cancelled.");
      }
      if (body.outcome === "failure") throw new AppError(402, "payment_failed", "The test payment was declined. Nothing was charged; you can try again.");
      res.json({ providerOrderId: body.providerOrderId, ...gateway.pay(body.providerOrderId) });
    });
  }

  // ---- The customer's orders ------------------------------------------------------------------

  router.get("/orders", ...customer, async (req, res) => {
    const q = parseQuery(pageQuery, req);
    const filter = { customerId: req.auth!.id };
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Order.countDocuments(filter),
    ]);
    const parts = await SubOrder.find({ orderId: { $in: orders.map((o) => o._id) } }).sort({ _id: 1 });
    res.json({
      items: orders.map((o) => toOrderSummary(o, parts.filter((p) => p.orderId.equals(o._id)), ctx.storage)),
      page: q.page,
      limit: q.limit,
      total,
    });
  });

  router.get("/orders/:id", ...customer, async (req, res) => {
    const order = await ownOrder(idParam(req), req.auth!.id);
    res.json({ order: await customerView(order), payment: order.status === "pending_payment" && order.payment?.providerOrderId ? paymentStep(order) : null });
  });

  // Cancels a whole order that hasn't been paid; its stock goes back on sale straight away.
  router.post("/orders/:id/cancel", ...customer, async (req, res) => {
    const order = await ownOrder(idParam(req), req.auth!.id);
    if (order.status !== "pending_payment") {
      throw new AppError(409, "invalid_transition", "This order is paid; cancel each store's part instead", { status: order.status });
    }
    await releaseReservation(deps, order.id as string, { to: "cancelled", reason: "Cancelled by the customer before paying", actor: { userId: req.auth!.id, role: "customer" } });
    res.json({ order: await customerView((await Order.findById(order._id))!) });
  });

  router.post("/orders/:id/sub-orders/:subId/cancel", ...customer, validateBody(cancelSchema), async (req, res) => {
    const order = await ownOrder(idParam(req), req.auth!.id);
    await cancelPart(deps, {
      orderId: order.id as string,
      subOrderId: idParam(req, "subId"),
      actor: { userId: req.auth!.id, role: "customer" },
      reason: (req.body as z.infer<typeof cancelSchema>).reason,
    });
    res.json({ order: await customerView((await Order.findById(order._id))!) });
  });

  // ---- The vendor's orders --------------------------------------------------------------------

  router.get("/vendor/orders", ...seller, async (req, res) => {
    const q = parseQuery(vendorListQuery, req);
    const vendorId = req.vendor!._id;
    // Only paid parts: an order waiting for payment isn't the vendor's business yet.
    const visible = { vendorId, placedAt: { $exists: true } };
    const filter = { ...visible, ...(q.status && { status: q.status }) };
    const [parts, total, counts] = await Promise.all([
      SubOrder.find(filter)
        .sort({ placedAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      SubOrder.countDocuments(filter),
      SubOrder.aggregate<{ _id: string; n: number }>([{ $match: visible }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const orders = await Order.find({ _id: { $in: parts.map((p) => p.orderId) } });
    const customers = await User.find({ _id: { $in: parts.map((p) => p.customerId) } }).select("name");
    res.json({
      items: parts.map((p) =>
        toVendorPart(
          p,
          orders.find((o) => o._id.equals(p.orderId)),
          customers.find((c) => c._id.equals(p.customerId))?.name,
          ctx.storage,
        ),
      ),
      page: q.page,
      limit: q.limit,
      total,
      counts: Object.fromEntries(["placed", "packed", "shipped", "delivered", "cancelled"].map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  router.post("/vendor/orders/:subId/status", ...seller, validateBody(statusSchema), async (req, res) => {
    const body = req.body as z.infer<typeof statusSchema>;
    const part = await advancePart(deps, {
      vendorId: req.vendor!.id as string,
      subOrderId: idParam(req, "subId"),
      to: body.status,
      tracking: body.tracking,
      actor: { userId: req.auth!.id, role: "vendor" },
    });
    const [order, customer] = await Promise.all([Order.findById(part.orderId), User.findById(part.customerId).select("name")]);
    res.json({ part: toVendorPart(part, order ?? undefined, customer?.name, ctx.storage) });
  });

  return router;
}
