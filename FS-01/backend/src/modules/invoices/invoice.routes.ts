import { Router } from "express";
import { AppError } from "../../middleware/errors.js";
import { idParam } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { SubOrder } from "../orders/order.model.js";
import { Vendor } from "../vendors/vendor.model.js";
import { Invoice } from "./invoice.model.js";

const LINK_SECONDS = 300;

// A 5-minute download link for one part's invoice. Only the buyer, the selling store and admins get one;
// anyone else gets 404, the same as for an invoice that doesn't exist.
export function invoiceRouter(ctx: RouteContext): Router {
  const router = Router();

  router.get("/invoices/:subId", ctx.signedIn, async (req, res) => {
    const part = await SubOrder.findById(idParam(req, "subId")).select("customerId vendorId placedAt orderNumber");
    let allowed = false;
    if (part && req.auth!.role === "admin") allowed = true;
    if (part && req.auth!.role === "customer") allowed = part.customerId.toString() === req.auth!.id;
    if (part && req.auth!.role === "vendor") allowed = (await Vendor.exists({ _id: part.vendorId, userId: req.auth!.id })) !== null;
    if (!part || !allowed) throw new AppError(404, "not_found", "Invoice not found");

    const invoice = await Invoice.findOne({ subOrderId: part._id });
    if (!invoice) {
      throw new AppError(404, part.placedAt ? "invoice_not_ready" : "not_found", part.placedAt ? "The invoice is being prepared. Try again in a moment." : "There's no invoice until the order is paid.");
    }
    const url = await ctx.storage.presignGet(invoice.s3Key, `${invoice.invoiceNumber}.pdf`, LINK_SECONDS);
    res.json({ invoiceNumber: invoice.invoiceNumber, url, expiresInSeconds: LINK_SECONDS });
  });

  return router;
}
