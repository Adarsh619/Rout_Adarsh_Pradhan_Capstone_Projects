import { Router } from "express";
import { z } from "zod";
import { cacheKeys, invalidate } from "../../lib/cache.js";
import { prisma } from "../../lib/db.js";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, patchSchema, validateBody } from "../../middleware/validate.js";
import { listStorefront, storefrontQuery } from "../catalog/storefront.js";
import type { RouteContext } from "../context.js";
import { checkUploadedImage, UPLOAD_PURPOSES } from "../uploads/upload-rules.js";
import { uniqueSlug } from "../../lib/slug.js";
import { loadOwnStore } from "./vendor-access.js";
import { toOwnStore, toPublicStore, VENDOR_STATUSES, type VendorRow, type VendorStatus } from "./vendor.model.js";

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

// Bank details for payouts. The full account number is passed to the payout provider and never stored.
const payoutSchema = z.object({
  accountHolder: z.string().trim().min(3, "Enter the account holder's name").max(80),
  accountNumber: z
    .string()
    .transform((s) => s.replace(/\s/g, ""))
    .refine((s) => /^\d{9,18}$/.test(s), "Enter the account number (9 to 18 digits)"),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .refine((s) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(s), "Enter the 11-character IFSC, e.g. HDFC0001234"),
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
  const slugTaken = async (slug: string) => (await prisma.vendor.count({ where: { slug } })) > 0;

  // A product page or list may show this store; drop cached copies when its status changes.
  const forgetStoreProducts = async (vendor: VendorRow) => {
    const products = await prisma.product.findMany({ where: { vendorId: vendor.id }, select: { id: true } });
    await invalidate(ctx.redis, ...products.map((p) => cacheKeys.product(p.id)));
  };

  // ---- The vendor's own store ------------------------------------------------------------------

  // First application, an edit while it waits, or a new attempt after a rejection.
  router.post("/vendors/apply", ...vendorOnly, validateBody(applySchema), async (req, res) => {
    const body = req.body as z.infer<typeof applySchema>;
    const existing = await prisma.vendor.findUnique({ where: { userId: req.auth!.id } });

    if (!existing) {
      const vendor = await prisma.vendor.create({
        data: { ...body, userId: req.auth!.id, slug: await uniqueSlug(body.storeName, slugTaken), status: "pending" },
      });
      res.status(201).json({ store: toOwnStore(vendor, ctx.storage) });
      return;
    }
    if (existing.status !== "pending" && existing.status !== "rejected") {
      throw new AppError(409, "already_applied", "Your store is already set up. Edit it from your store settings.");
    }
    // Not public yet, so the URL can still follow the name.
    const slug =
      body.storeName !== existing.storeName
        ? await uniqueSlug(body.storeName, async (s) => s !== existing.slug && (await slugTaken(s)))
        : existing.slug;
    const updated = await prisma.vendor.update({
      where: { id: existing.id },
      data: { ...body, gstin: body.gstin ?? null, slug, status: "pending", rejectionReason: null, submittedAt: new Date() },
    });
    res.json({ store: toOwnStore(updated, ctx.storage) });
  });

  router.get("/vendors/me", ...vendorOnly, async (req, res) => {
    const vendor = await prisma.vendor.findUnique({ where: { userId: req.auth!.id } });
    res.json({ store: vendor ? toOwnStore(vendor, ctx.storage) : null });
  });

  router.patch("/vendors/me", ...vendorOnly, loadOwnStore({ approved: false }), validateBody(updateSchema), async (req, res) => {
    const current = req.vendor!;
    if (current.status === "suspended") {
      throw new AppError(403, "vendor_not_approved", "Your store is suspended, so it can't be changed right now.", {
        storeStatus: current.status,
      });
    }
    const { logoKey, ...fields } = req.body as z.infer<typeof updateSchema>;
    const oldLogo = current.logoKey;
    if (logoKey && logoKey !== oldLogo) {
      const problem = await checkUploadedImage(ctx.storage, logoKey, UPLOAD_PURPOSES["store-logo"](current.id));
      if (problem) throw new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field: "logoKey", message: problem }] });
    }
    const vendor = await prisma.vendor.update({
      where: { id: current.id },
      data: {
        ...fields,
        ...("gstin" in fields && { gstin: fields.gstin ?? null }),
        ...(logoKey !== undefined && { logoKey }),
      },
    });
    if (oldLogo && oldLogo !== vendor.logoKey) void ctx.storage.deleteMany([oldLogo]);
    if (vendor.status === "approved") {
      await forgetStoreProducts(vendor);
      // Search results show the store's name.
      await ctx.searchSync.vendor(vendor.id);
    }
    res.json({ store: toOwnStore(vendor, ctx.storage) });
  });

  // Saves where the store's earnings are paid. Shares already released wait for this, so they're sent now.
  router.put("/vendors/me/payout", ...vendorOnly, loadOwnStore({ approved: false }), validateBody(payoutSchema), async (req, res) => {
    const body = req.body as z.infer<typeof payoutSchema>;
    const { beneficiaryRef } = await ctx.payouts.registerBeneficiary({ vendorId: req.vendor!.id, ...body });
    const vendor = await prisma.vendor.update({
      where: { id: req.vendor!.id },
      data: {
        payoutAccountHolder: body.accountHolder,
        payoutBankLast4: body.accountNumber.slice(-4),
        payoutIfsc: body.ifsc,
        payoutProvider: ctx.payouts.name,
        payoutBeneficiaryRef: beneficiaryRef,
        payoutStatus: "active",
        payoutUpdatedAt: new Date(),
      },
    });
    const waiting = await prisma.subOrder.findMany({
      where: { vendorId: vendor.id, payoutStatus: { in: ["released", "failed"] } },
      select: { id: true },
    });
    for (const part of waiting) await ctx.moneyJobs.payout(part.id);
    res.json({ store: toOwnStore(vendor, ctx.storage), payoutsStarted: waiting.length });
  });

  // ---- Public store page -----------------------------------------------------------------------

  router.get("/stores/:slug", async (req, res) => {
    const q = parseQuery(storefrontQuery, req);
    const vendor = await prisma.vendor.findFirst({ where: { slug: req.params.slug, status: "approved" } });
    if (!vendor) throw new AppError(404, "not_found", "Store not found");
    const products = await listStorefront({ vendorId: vendor.id, categorySlug: q.category, sort: q.sort, page: q.page, limit: q.limit }, ctx.storage);
    res.json({ store: toPublicStore(vendor, ctx.storage), products });
  });

  // ---- Admin -----------------------------------------------------------------------------------

  const adminListQuery = pageQuery.extend({ status: z.enum(VENDOR_STATUSES).optional() });

  router.get("/admin/vendors", ...adminOnly, async (req, res) => {
    const q = parseQuery(adminListQuery, req);
    const where = q.status ? { status: q.status } : {};
    const [vendors, total, counts] = await Promise.all([
      // Oldest pending application first, so nobody waits forever.
      prisma.vendor.findMany({
        where,
        orderBy: { submittedAt: q.status === "pending" ? "asc" : "desc" },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { owner: { select: { id: true, name: true, email: true } }, _count: { select: { products: true } } },
      }),
      prisma.vendor.count({ where }),
      prisma.vendor.groupBy({ by: ["status"], _count: { _all: true } }),
    ]);
    res.json({
      items: vendors.map(({ owner, _count, ...v }) => ({ ...toOwnStore(v, ctx.storage), owner, productCount: _count.products })),
      page: q.page,
      limit: q.limit,
      total,
      counts: Object.fromEntries(VENDOR_STATUSES.map((s) => [s, counts.find((c) => c.status === s)?._count._all ?? 0])),
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
      const [vendor] = await prisma.vendor.updateManyAndReturn({
        where: { id, status: { in: [...rule.from] } },
        data: {
          status: rule.to,
          statusChangedAt: now,
          statusChangedBy: req.auth!.id,
          ...(rule.to === "approved" && { approvedAt: now, approvedBy: req.auth!.id }),
          rejectionReason: reason ?? null,
        },
      });
      if (!vendor) {
        const current = await prisma.vendor.findUnique({ where: { id }, select: { status: true } });
        if (!current) throw new AppError(404, "not_found", "Vendor not found");
        throw new AppError(409, "invalid_transition", `Can't ${action} a store that is ${current.status}`, {
          status: current.status,
          allowedFrom: rule.from,
        });
      }
      await forgetStoreProducts(vendor);
      // Approving adds the store's products to search; suspending removes them.
      await ctx.searchSync.vendor(vendor.id);
      res.json({ store: toOwnStore(vendor, ctx.storage) });
    });
  }

  return router;
}
