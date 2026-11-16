import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/db.js";
import { cancelPart } from "../orders/order-service.js";
import { loadOwnStore } from "../vendors/vendor-access.js";
import { toOwnStore } from "../vendors/vendor.model.js";
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
      ...(await vendorEarnings(vendor.id, resolveRange(q), q)),
      // Released shares wait for this.
      payoutAccount: vendor.payoutStatus === "active",
    });
  });

  // ---- Commission rates --------------------------------------------------------------------------

  // A store's own rate, used instead of its categories' rates for new orders (placed orders keep theirs).
  router.patch("/admin/vendors/:id/commission", ...admin, validateBody(commissionSchema), async (req, res) => {
    const [vendor] = await prisma.vendor.updateManyAndReturn({
      where: { id: idParam(req) },
      data: { commissionRateBp: (req.body as z.infer<typeof commissionSchema>).commissionRateBp },
    });
    if (!vendor) throw new AppError(404, "not_found", "Store not found");
    res.json({ store: toOwnStore(vendor, ctx.storage) });
  });

  // ---- Orders and refunds ------------------------------------------------------------------------

  router.get("/admin/orders", ...admin, async (req, res) => {
    const q = parseQuery(ordersQuery, req);
    const where: Prisma.OrderWhereInput = {
      // A customer's email (exact), or an order number ending in what was typed (SS-2026-000123, or just 123).
      ...(q.q && (q.q.includes("@") ? { customer: { email: q.q.toLowerCase() } } : { orderNumber: { endsWith: q.q.toUpperCase() } })),
      ...(q.refund && { subOrders: { some: { refundStatus: q.refund } } }),
    };
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { customer: { select: { name: true, email: true } }, subOrders: { orderBy: { id: "asc" } } },
      }),
      prisma.order.count({ where }),
    ]);
    res.json({
      items: orders.map((o) => ({
        id: o.id,
        orderNumber: o.orderNumber,
        status: o.status,
        createdAt: o.createdAt.toISOString(),
        grandTotal: o.grandTotal,
        discount: o.discount,
        coupon: o.couponCode,
        payment: { provider: o.paymentProvider, status: o.paymentStatus, refundedAmount: o.refundedAmount, reference: o.paymentProviderPaymentId },
        customer: { name: o.customer.name, email: o.customer.email },
        parts: o.subOrders.map((p) => ({
          id: p.id,
          storeName: p.vendorName,
          status: p.status,
          payable: p.payable,
          payout: p.payoutStatus,
          refund: p.refundAmount ? { amount: p.refundAmount, status: p.refundStatus ?? "pending", lastError: p.refundLastError } : null,
          canRefund: ["placed", "packed", "shipped"].includes(p.status),
        })),
      })),
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
    const fresh = await prisma.subOrder.findUnique({ where: { id: part.id } });
    res.json({ part: { id: part.id, status: fresh?.status, refund: fresh?.refundAmount ? { amount: fresh.refundAmount, status: fresh.refundStatus } : null } });
  });

  // Tries a refund the payment provider refused again now, instead of waiting for the hourly retry.
  router.post("/admin/sub-orders/:subId/refund/retry", ...admin, async (req, res) => {
    const part = await prisma.subOrder.findUnique({ where: { id: idParam(req, "subId") } });
    if (!part?.refundAmount) throw new AppError(404, "not_found", "No refund for this part");
    if (part.refundProviderRef) throw new AppError(409, "invalid_transition", "This refund was already sent");
    await ctx.moneyJobs.refund(part.id);
    const fresh = await prisma.subOrder.findUniqueOrThrow({ where: { id: part.id } });
    res.json({ refund: { amount: fresh.refundAmount, status: fresh.refundStatus, lastError: fresh.refundLastError } });
  });

  return router;
}
