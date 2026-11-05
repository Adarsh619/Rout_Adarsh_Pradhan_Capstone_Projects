import { Router } from "express";
import { z } from "zod";
import { cacheKeys, invalidate } from "../../lib/cache.js";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, patchSchema, validateBody } from "../../middleware/validate.js";
import { listStorefront, storefrontQuery } from "../catalog/storefront.js";
import { Product } from "../catalog/product.model.js";
import type { RouteContext } from "../context.js";
import { checkUploadedImage, UPLOAD_PURPOSES } from "../uploads/upload-rules.js";
import { User } from "../users/user.model.js";
import { uniqueSlug } from "../../lib/slug.js";
import { loadOwnStore } from "./vendor-access.js";
import { toOwnStore, toPublicStore, Vendor, VENDOR_STATUSES, type VendorDoc, type VendorStatus } from "./vendor.model.js";

// Indian mobile number, with or without +91 / spaces / dashes; stored as the 10 digits.
const phone = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, "").replace(/^(\+91|0)/, ""))
  .refine((s) => /^[6-9]\d{9}$/.test(s), "Enter a 10-digit Indian mobile number");
// 15-character GST number, e.g. 29ABCDE1234F1Z5. Optional: small sellers may not have one.
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine((s) => s === "" || /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s), "Enter a valid 15-character GSTIN")
  .transform((s) => s || undefined);

const storeFields = {
  storeName: z.string().trim().min(3, "Store name needs at least 3 characters").max(60),
  description: z.string().trim().max(1000).default(""),
  contactEmail: z.string().trim().toLowerCase().email("Enter a valid email address").max(254),
  phone,
  gstin: gstin.optional(),
};
const applySchema = z.object(storeFields);
const updateSchema = patchSchema({
  ...storeFields,
  // A key from POST /uploads/presign (purpose store-logo), or null to remove the logo.
  logoKey: z.string().max(300).nullable(),
});

const reasonSchema = z.object({ reason: z.string().trim().min(5, "Give the vendor a short reason").max(500) });

// Which admin action is allowed from which status. Anything else is 409 invalid_transition.
const ACTIONS = {
  approve: { from: ["pending"], to: "approved", needsReason: false },
  reject: { from: ["pending"], to: "rejected", needsReason: true },
  suspend: { from: ["approved"], to: "suspended", needsReason: true },
  restore: { from: ["suspended"], to: "approved", needsReason: false },
} as const satisfies Record<string, { from: readonly VendorStatus[]; to: VendorStatus; needsReason: boolean }>;

export function vendorRouter(ctx: RouteContext): Router {
  const router = Router();
  const vendorOnly = [ctx.signedIn, requireRole("vendor")];
  const adminOnly = [ctx.signedIn, requireRole("admin")];
  const slugTaken = async (slug: string) => (await Vendor.exists({ slug })) !== null;

  // A product page or list may show this store; drop cached copies when its status changes.
  const forgetStoreProducts = async (vendor: VendorDoc) => {
    const ids = await Product.find({ vendorId: vendor._id }).distinct("_id");
    await invalidate(ctx.redis, ...ids.map((id) => cacheKeys.product(id.toString())));
  };

  // ---- The vendor's own store ------------------------------------------------------------------

  // First application, an edit while it waits, or a new attempt after a rejection.
  router.post("/vendors/apply", ...vendorOnly, validateBody(applySchema), async (req, res) => {
    const body = req.body as z.infer<typeof applySchema>;
    const existing = await Vendor.findOne({ userId: req.auth!.id });

    if (!existing) {
      const vendor = await Vendor.create({
        ...body,
        userId: req.auth!.id,
        slug: await uniqueSlug(body.storeName, slugTaken),
        status: "pending",
      });
      res.status(201).json({ store: toOwnStore(vendor, ctx.storage) });
      return;
    }
    if (existing.status !== "pending" && existing.status !== "rejected") {
      throw new AppError(409, "already_applied", "Your store is already set up. Edit it from your store settings.");
    }
    // Not public yet, so the URL can still follow the name.
    if (body.storeName !== existing.storeName) {
      existing.slug = await uniqueSlug(body.storeName, async (s) => s !== existing.slug && (await slugTaken(s)));
    }
    Object.assign(existing, body, { status: "pending", rejectionReason: undefined, submittedAt: new Date() });
    if (!body.gstin) existing.gstin = undefined;
    await existing.save();
    res.json({ store: toOwnStore(existing, ctx.storage) });
  });

  router.get("/vendors/me", ...vendorOnly, async (req, res) => {
    const vendor = await Vendor.findOne({ userId: req.auth!.id });
    res.json({ store: vendor ? toOwnStore(vendor, ctx.storage) : null });
  });

  router.patch("/vendors/me", ...vendorOnly, loadOwnStore({ approved: false }), validateBody(updateSchema), async (req, res) => {
    const vendor = req.vendor!;
    if (vendor.status === "suspended") {
      throw new AppError(403, "vendor_not_approved", "Your store is suspended, so it can't be changed right now.", {
        storeStatus: vendor.status,
      });
    }
    const { logoKey, ...fields } = req.body as z.infer<typeof updateSchema>;
    const oldLogo = vendor.logoKey;
    if (logoKey !== undefined && logoKey !== oldLogo) {
      if (logoKey) {
        const problem = await checkUploadedImage(ctx.storage, logoKey, UPLOAD_PURPOSES["store-logo"](vendor.id as string));
        if (problem) throw new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field: "logoKey", message: problem }] });
      }
      vendor.logoKey = logoKey ?? undefined;
    }
    Object.assign(vendor, fields);
    if (fields.gstin === undefined && "gstin" in fields) vendor.gstin = undefined;
    await vendor.save();
    if (oldLogo && oldLogo !== vendor.logoKey) void ctx.storage.deleteMany([oldLogo]);
    if (vendor.status === "approved") {
      await forgetStoreProducts(vendor);
      // Search results show the store's name.
      await ctx.searchSync.vendor(vendor._id);
    }
    res.json({ store: toOwnStore(vendor, ctx.storage) });
  });

  // ---- Public store page -----------------------------------------------------------------------

  router.get("/stores/:slug", async (req, res) => {
    const q = parseQuery(storefrontQuery, req);
    const vendor = await Vendor.findOne({ slug: req.params.slug, status: "approved" });
    if (!vendor) throw new AppError(404, "not_found", "Store not found");
    const products = await listStorefront({ vendorId: vendor._id, categorySlug: q.category, sort: q.sort, page: q.page, limit: q.limit }, ctx.storage);
    res.json({ store: toPublicStore(vendor, ctx.storage), products });
  });

  // ---- Admin -----------------------------------------------------------------------------------

  const adminListQuery = pageQuery.extend({ status: z.enum(VENDOR_STATUSES).optional() });

  router.get("/admin/vendors", ...adminOnly, async (req, res) => {
    const q = parseQuery(adminListQuery, req);
    const filter = q.status ? { status: q.status } : {};
    const [vendors, total, counts] = await Promise.all([
      // Oldest pending application first, so nobody waits forever.
      Vendor.find(filter)
        .sort(q.status === "pending" ? { submittedAt: 1 } : { submittedAt: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Vendor.countDocuments(filter),
      Vendor.aggregate<{ _id: VendorStatus; n: number }>([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    const [owners, productCounts] = await Promise.all([
      User.find({ _id: { $in: vendors.map((v) => v.userId) } }).select("name email"),
      Product.aggregate<{ _id: unknown; n: number }>([
        { $match: { vendorId: { $in: vendors.map((v) => v._id) } } },
        { $group: { _id: "$vendorId", n: { $sum: 1 } } },
      ]),
    ]);
    const ownerById = new Map(owners.map((u) => [u.id as string, u]));
    const productsById = new Map(productCounts.map((c) => [String(c._id), c.n]));
    res.json({
      items: vendors.map((v) => {
        const owner = ownerById.get(v.userId.toString());
        return {
          ...toOwnStore(v, ctx.storage),
          owner: owner ? { id: owner.id as string, name: owner.name, email: owner.email } : null,
          productCount: productsById.get(v.id as string) ?? 0,
        };
      }),
      page: q.page,
      limit: q.limit,
      total,
      counts: Object.fromEntries(VENDOR_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  for (const [action, rule] of Object.entries(ACTIONS)) {
    router.post(`/admin/vendors/:id/${action}`, ...adminOnly, async (req, res) => {
      const id = idParam(req);
      let reason: string | undefined;
      if (rule.needsReason) {
        const parsed = reasonSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          throw new AppError(400, "validation_error", "Some fields need fixing", {
            fields: [{ field: "reason", message: parsed.error.issues[0]!.message }],
          });
        }
        reason = parsed.data.reason;
      }

      const now = new Date();
      // Conditional update: two admins clicking at once can't both act on the same application.
      const vendor = await Vendor.findOneAndUpdate(
        { _id: id, status: { $in: rule.from } },
        {
          $set: {
            status: rule.to,
            statusChangedAt: now,
            statusChangedBy: req.auth!.id,
            ...(rule.to === "approved" && { approvedAt: now, approvedBy: req.auth!.id }),
            ...(reason && { rejectionReason: reason }),
          },
          ...(!reason && { $unset: { rejectionReason: 1 } }),
        },
        { returnDocument: "after" },
      );
      if (!vendor) {
        const current = await Vendor.findById(id).select("status");
        if (!current) throw new AppError(404, "not_found", "Vendor not found");
        throw new AppError(409, "invalid_transition", `Can't ${action} a store that is ${current.status}`, {
          status: current.status,
          allowedFrom: rule.from,
        });
      }
      await forgetStoreProducts(vendor);
      // Approving adds the store's products to search; suspending removes them.
      await ctx.searchSync.vendor(vendor._id);
      res.json({ store: toOwnStore(vendor, ctx.storage) });
    });
  }

  return router;
}
