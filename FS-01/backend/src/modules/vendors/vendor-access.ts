import type { RequestHandler } from "express";
import { AppError } from "../../middleware/errors.js";
import { Vendor, type VendorDoc } from "./vendor.model.js";

declare module "express-serve-static-core" {
  interface Request {
    vendor?: VendorDoc;
  }
}

// Use after requireAuth + requireRole("vendor"). Loads the signed-in vendor's store into req.vendor.
// approved: true also requires the store to be approved (selling, products, uploads of product photos).
export const loadOwnStore =
  ({ approved }: { approved: boolean }): RequestHandler =>
  async (req, _res, next) => {
    try {
      const vendor = await Vendor.findOne({ userId: req.auth!.id });
      if (!vendor) {
        if (approved) throw notApproved("none");
        throw new AppError(404, "store_not_found", "You haven't applied for a store yet");
      }
      if (approved && vendor.status !== "approved") throw notApproved(vendor.status);
      req.vendor = vendor;
      next();
    } catch (err) {
      next(err);
    }
  };

const MESSAGES: Record<string, string> = {
  none: "Apply for your store first. You can add products once an admin approves it.",
  pending: "Your store is waiting for approval. You can add products once an admin approves it.",
  rejected: "Your store application was not approved. Update it and apply again.",
  suspended: "Your store is suspended, so it can't be changed right now. Contact support.",
};

const notApproved = (storeStatus: string) =>
  new AppError(403, "vendor_not_approved", MESSAGES[storeStatus] ?? MESSAGES.none!, { storeStatus });
