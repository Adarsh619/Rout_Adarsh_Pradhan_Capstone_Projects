import { createHash } from "node:crypto";
import { Router, type Request } from "express";
import { logger } from "../../lib/logger.js";
import { AppError } from "../../middleware/errors.js";
import type { RouteContext } from "../context.js";
import { isUniqueViolation, prisma } from "../../lib/db.js";
import { isEntityId } from "../../middleware/validate.js";
import { markPaid, refundLatePayment, type OrderDeps } from "../orders/order-service.js";
import { webhookSignatureValid } from "./payment-provider.js";

declare module "express-serve-static-core" {
  interface Request {
    // The exact bytes received, kept by express.json() for signature checks.
    rawBody?: Buffer;
  }
}

type Entity = Record<string, unknown> & { id?: string; notes?: Record<string, string> | unknown[] };
type RazorpayEvent = { event?: string; payload?: { payment?: { entity?: Entity }; refund?: { entity?: Entity } } };

// What each event does. Every handler is safe to run twice and in any order: it reads the current state first.
async function handle(deps: OrderDeps, event: RazorpayEvent): Promise<string> {
  const payment = event.payload?.payment?.entity;
  const refund = event.payload?.refund?.entity;
  // Never query with a missing id: { field: undefined } would match every document.
  const providerOrderId = typeof payment?.order_id === "string" ? payment.order_id : undefined;
  const paymentId = typeof payment?.id === "string" ? payment.id : undefined;

  switch (event.event) {
    // The money is taken. Usually the popup's callback got here first and this changes nothing; if the customer closed
    // the tab before the callback ran, this is what confirms the order.
    case "payment.captured": {
      if (!providerOrderId || !paymentId) return "ignored";
      const order = await prisma.order.findUnique({ where: { paymentProviderOrderId: providerOrderId } });
      if (!order) return "unknown order";
      if (order.status === "pending_payment") {
        await markPaid(deps, order.id, paymentId);
        return "order confirmed";
      }
      if (order.status === "expired" || order.status === "cancelled") {
        await refundLatePayment(deps, order, paymentId);
        return "late payment refunded";
      }
      return "already confirmed";
    }
    case "payment.failed": {
      // The order stays open for another try until its reservation ends.
      if (!providerOrderId) return "ignored";
      const res = await prisma.order.updateMany({
        where: { paymentProviderOrderId: providerOrderId, status: "pending_payment" },
        data: { paymentStatus: "failed" },
      });
      return res.count ? "attempt failed, order still payable" : "ignored";
    }
    case "refund.processed":
    case "refund.failed": {
      const status = event.event === "refund.processed" ? "processed" : "failed";
      const key = refund && !Array.isArray(refund.notes) ? refund.notes?.key : undefined;
      // Our refunds carry "refund-<part id>" in their notes, so the event finds its part even if it arrives before
      // our own record of the refund id was saved.
      const subId = key?.startsWith("refund-") ? key.slice("refund-".length) : undefined;
      const refundId = typeof refund?.id === "string" ? refund.id : undefined;
      if (!isEntityId(subId) && !refundId) return "ignored";
      const res = await prisma.subOrder.updateMany({
        where: isEntityId(subId) ? { id: subId } : { refundProviderRef: refundId },
        data: { refundStatus: status, ...(status === "processed" && { refundProcessedAt: new Date() }) },
      });
      return res.count ? `refund ${status}` : "ignored";
    }
    default:
      return "ignored";
  }
}

// Razorpay calls this for payment and refund events. The body is signed with the webhook secret; anything unsigned
// or wrongly signed is refused. Each event id is handled once, however often Razorpay delivers it.
export function webhookRouter(ctx: RouteContext): Router {
  const router = Router();
  const deps: OrderDeps = {
    redis: ctx.redis,
    searchSync: ctx.searchSync,
    payments: ctx.payments,
    reservations: ctx.reservations,
    reservationMinutes: ctx.reservationMinutes,
    moneyJobs: ctx.moneyJobs,
    invoiceJobs: ctx.invoiceJobs,
  };

  const eventId = (req: Request) =>
    req.get("x-razorpay-event-id") ?? `body-${createHash("sha256").update(req.rawBody ?? Buffer.alloc(0)).digest("hex").slice(0, 32)}`;

  router.post("/webhooks/razorpay", async (req, res) => {
    if (!ctx.webhookSecret) throw new AppError(503, "webhook_not_configured", "Webhooks aren't set up on this server");
    const signature = req.get("x-razorpay-signature");
    if (!signature || !req.rawBody || !webhookSignatureValid(ctx.webhookSecret, req.rawBody, signature)) {
      throw new AppError(400, "invalid_signature", "Webhook signature doesn't match");
    }
    const event = req.body as RazorpayEvent;
    const id = eventId(req);
    const type = event.event ?? "unknown";

    // Claim the event. A repeat of one already handled is acknowledged and skipped; a failed one is tried again.
    const where = { provider_eventId: { provider: "razorpay" as const, eventId: id } };
    const existing = await prisma.webhookEvent.findUnique({ where });
    if (existing && existing.status !== "failed") {
      res.json({ ok: true, duplicate: true });
      return;
    }
    if (!existing) {
      try {
        await prisma.webhookEvent.create({ data: { provider: "razorpay", eventId: id, type, status: "processing", receivedAt: new Date() } });
      } catch (err) {
        // Two deliveries at the same moment: the other one is handling it.
        if (isUniqueViolation(err)) {
          res.json({ ok: true, duplicate: true });
          return;
        }
        throw err;
      }
    }

    try {
      const result = await handle(deps, event);
      await prisma.webhookEvent.update({
        where,
        data: { status: result === "ignored" ? "ignored" : "processed", result, processedAt: new Date(), error: null },
      });
      res.json({ ok: true, result });
    } catch (err) {
      logger.error({ err, eventId: id, type }, "webhook failed");
      await prisma.webhookEvent.update({ where, data: { status: "failed", error: String(err) } });
      // A non-2xx answer makes Razorpay deliver it again later.
      throw new AppError(500, "webhook_failed", "Couldn't process the event; it will be retried");
    }
  });

  return router;
}
