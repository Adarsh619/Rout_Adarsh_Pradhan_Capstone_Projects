import { Router } from "express";
import { AppError } from "../../middleware/errors.js";
import { idParam } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { prisma } from "../../lib/db.js";

const LINK_SECONDS = 300;

// A 5-minute download link for one part's invoice. Only the buyer, the selling store and admins get one;
// anyone else gets 404, the same as for an invoice that doesn't exist.
export function invoiceRouter(ctx: RouteContext): Router {
  const router = Router();

  router.get("/invoices/:subId", ctx.signedIn, async (req, res) => {
    const part = await prisma.subOrder.findUnique({
      where: { id: idParam(req, "subId") },
      select: { id: true, customerId: true, vendorId: true, placedAt: true, invoice: true },
    });
    let allowed = false;
    if (part && req.auth!.role === "admin") allowed = true;
    if (part && req.auth!.role === "customer") allowed = part.customerId === req.auth!.id;
    if (part && req.auth!.role === "vendor") allowed = (await prisma.vendor.count({ where: { id: part.vendorId, userId: req.auth!.id } })) > 0;
    if (!part || !allowed) throw new AppError(404, "not_found", "Invoice not found");

    const invoice = part.invoice;
    if (!invoice) {
      throw new AppError(404, part.placedAt ? "invoice_not_ready" : "not_found", part.placedAt ? "The invoice is being prepared. Try again in a moment." : "There's no invoice until the order is paid.");
    }
    const url = await ctx.storage.presignGet(invoice.s3Key, `${invoice.invoiceNumber}.pdf`, LINK_SECONDS);
    res.json({ invoiceNumber: invoice.invoiceNumber, url, expiresInSeconds: LINK_SECONDS });
  });

  return router;
}
