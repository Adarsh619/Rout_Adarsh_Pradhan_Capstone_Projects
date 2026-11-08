import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { Order, SubOrder } from "../orders/order.model.js";
import { cancelPart } from "../orders/order-service.js";
import { User } from "../users/user.model.js";
import { loadOwnStore } from "../vendors/vendor-access.js";
import { toOwnStore, Vendor } from "../vendors/vendor.model.js";
import { adminAnalytics, vendorEarnings } from "./analytics.js";
import { rangeQuery, resolveRange } from "./date-range.js";

const commissionSchema = z.object({
  // 0–50% in basis points, or null to go back to the category's rate.
  commissionRateBp: z.number().int().min(0, "0% or more").max(5000, "At most 50%").nullable(),
});

const refundSchema = z.object({ reason: z.string().trim().min(5, "Say why, for the customer and the store").max(300) });

const ordersQuery = pageQuery.extend({
  // An order number (SS-2026-000123, or just 123) or a customer's email.
  q: z.string().trim().max(100).optional(),
  refund: z.enum(["failed", "pending", "processed"]).optional(),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function analyticsRouter(ctx: RouteContext): Router {
  const router = Router();
  const admin = [ctx.signedIn, requireRole("admin")];
  const seller = [ctx.signedIn, requireRole("vendor"), loadOwnStore({ approved: false })];

  router.get("/admin/analytics", ...admin, async (req, res) => {
    res.json(await adminAnalytics(resolveRange(parseQuery(rangeQuery, req))));
  });

  router.get("/vendor/earnings", ...seller, async (req, res) => {
    const q = parseQuery(rangeQuery.extend(pageQuery.shape), req);
    const vendor = req.vendor!;
    res.json({
      ...(await vendorEarnings(vendor._id, resolveRange(q), q)),
      // Released shares wait for this.
      payoutAccount: vendor.payout?.status === "active",
    });
  });

  // ---- Commission rates --------------------------------------------------------------------------

  // A store's own rate, used instead of its categories' rates for new orders (placed orders keep theirs).
  router.patch("/admin/vendors/:id/commission", ...admin, validateBody(commissionSchema), async (req, res) => {
    const vendor = await Vendor.findById(idParam(req));
    if (!vendor) throw new AppError(404, "not_found", "Store not found");
    vendor.commissionRateBp = (req.body as z.infer<typeof commissionSchema>).commissionRateBp;
    await vendor.save();
    res.json({ store: toOwnStore(vendor, ctx.storage) });
  });

  // ---- Orders and refunds ------------------------------------------------------------------------

  router.get("/admin/orders", ...admin, async (req, res) => {
    const q = parseQuery(ordersQuery, req);
    const filter: Record<string, unknown> = {};
    if (q.q) {
      if (q.q.includes("@")) {
        const user = await User.findOne({ email: q.q.toLowerCase() }).select("_id");
        filter.customerId = user?._id ?? null;
      } else {
        filter.orderNumber = { $regex: `${escapeRegex(q.q.toUpperCase())}$` };
      }
    }
    if (q.refund) {
      const parts = await SubOrder.find({ "refund.status": q.refund }).select("orderId");
      filter._id = { $in: parts.map((p) => p.orderId) };
    }
    const [orders, total] = await Promise.all([
      Order.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Order.countDocuments(filter),
    ]);
    const [parts, customers] = await Promise.all([
      SubOrder.find({ orderId: { $in: orders.map((o) => o._id) } }).sort({ _id: 1 }),
      User.find({ _id: { $in: orders.map((o) => o.customerId) } }).select("name email"),
    ]);
    res.json({
      items: orders.map((o) => {
        const customer = customers.find((c) => c._id.equals(o.customerId));
        return {
          id: o.id as string,
          orderNumber: o.orderNumber,
          status: o.status,
          createdAt: (o.createdAt as Date).toISOString(),
          grandTotal: o.grandTotal,
          discount: o.discount,
          coupon: o.coupon?.code ?? null,
          payment: { provider: o.payment?.provider, status: o.payment?.status, refundedAmount: o.payment?.refundedAmount ?? 0, reference: o.payment?.providerPaymentId ?? null },
          customer: { name: customer?.name ?? "", email: customer?.email ?? "" },
          parts: parts
            .filter((p) => p.orderId.equals(o._id))
            .map((p) => ({
              id: p.id as string,
              storeName: p.vendorName,
              status: p.status,
              payable: p.payable,
              payout: p.payout?.status ?? null,
              refund: p.refund?.amount ? { amount: p.refund.amount, status: p.refund.status ?? "pending", lastError: p.refund.lastError ?? null } : null,
              canRefund: ["placed", "packed", "shipped"].includes(p.status),
            })),
        };
      }),
      page: q.page,
      limit: q.limit,
      total,
    });
  });

  // Support cancels a part and refunds the customer, e.g. a parcel lost in transit. Same money rules as a customer
  // cancellation: stock back, the store's share and the commission reversed, what was paid refunded.
  router.post("/admin/sub-orders/:subId/refund", ...admin, validateBody(refundSchema), async (req, res) => {
    const part = await cancelPart(
      { redis: ctx.redis, searchSync: ctx.searchSync, moneyJobs: ctx.moneyJobs },
      { subOrderId: idParam(req, "subId"), actor: { userId: req.auth!.id, role: "admin" }, reason: (req.body as z.infer<typeof refundSchema>).reason },
    );
    const fresh = await SubOrder.findById(part._id);
    res.json({ part: { id: part.id as string, status: fresh?.status, refund: fresh?.refund?.amount ? { amount: fresh.refund.amount, status: fresh.refund.status } : null } });
  });

  // Tries a refund the payment provider refused again now, instead of waiting for the hourly retry.
  router.post("/admin/sub-orders/:subId/refund/retry", ...admin, async (req, res) => {
    const part = await SubOrder.findById(idParam(req, "subId"));
    if (!part?.refund?.amount) throw new AppError(404, "not_found", "No refund for this part");
    if (part.refund.providerRef) throw new AppError(409, "invalid_transition", "This refund was already sent");
    await ctx.moneyJobs.refund(part.id as string);
    const fresh = await SubOrder.findById(part._id);
    res.json({ refund: { amount: fresh!.refund!.amount, status: fresh!.refund!.status, lastError: fresh!.refund!.lastError ?? null } });
  });

  return router;
}
