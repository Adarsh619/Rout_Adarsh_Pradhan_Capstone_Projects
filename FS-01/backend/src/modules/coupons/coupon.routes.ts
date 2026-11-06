import { Router, type Request } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, patchSchema, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { loadOwnStore } from "../vendors/vendor-access.js";
import { Coupon, toCouponView, type CouponDoc } from "./coupon.model.js";

const paise = z.number().int().min(100, "At least ₹1").max(100_000_000);

// Everything but the code can be changed later; the code can't, once customers may have it.
const editable = {
  type: z.enum(["percent", "flat"]),
  // percent: basis points (1000 = 10%), up to 90%; flat: paise.
  value: z.number({ error: "Enter the discount" }).int().min(1),
  maxDiscount: paise.nullable().default(null),
  minOrder: z.number().int().min(0).max(100_000_000).default(0),
  startsAt: z.coerce.date().nullable().default(null),
  endsAt: z.coerce.date().nullable().default(null),
  usageLimit: z.number().int().min(1).max(1_000_000).nullable().default(null),
  perUserLimit: z.number().int().min(1).max(100).default(1),
  isActive: z.boolean().default(true),
  description: z.string().trim().max(140).default(""),
};
const createSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4,20}$/, "4 to 20 letters and numbers, no spaces"),
  ...editable,
});
const updateSchema = patchSchema(editable);
type CouponInput = z.infer<typeof createSchema>;

function checkCoupon(c: Pick<CouponInput, "type" | "value" | "startsAt" | "endsAt" | "maxDiscount">) {
  const fields: { field: string; message: string }[] = [];
  if (c.type === "percent" && (c.value < 100 || c.value > 9000)) fields.push({ field: "value", message: "A percentage between 1% and 90%" });
  if (c.type === "flat" && c.value < 100) fields.push({ field: "value", message: "At least ₹1" });
  if (c.type === "flat" && c.maxDiscount) fields.push({ field: "maxDiscount", message: "Only for percentage coupons" });
  if (c.startsAt && c.endsAt && c.endsAt <= c.startsAt) fields.push({ field: "endsAt", message: "Must be after the start" });
  if (fields.length) throw new AppError(400, "validation_error", "Some fields need fixing", { fields });
}

const codeTaken = (err: unknown) => {
  if ((err as { code?: number }).code === 11000) {
    throw new AppError(409, "code_taken", "A coupon with this code already exists", { fields: [{ field: "code", message: "This code is already used" }] });
  }
  throw err;
};

const listQuery = pageQuery.extend({ active: z.enum(["true", "false"]).optional() });

// Platform coupons are run by admins; vendor coupons by each store, for its own items only.
export function couponRouter(ctx: RouteContext): Router {
  const router = Router();
  const admin = [ctx.signedIn, requireRole("admin")];
  const seller = [ctx.signedIn, requireRole("vendor"), loadOwnStore({ approved: true })];

  const scopeOf = (req: Request) => (req.vendor ? { scope: "vendor" as const, vendorId: req.vendor._id } : { scope: "platform" as const });

  async function list(req: Request) {
    const q = parseQuery(listQuery, req);
    const filter = { ...scopeOf(req), ...(q.active && { isActive: q.active === "true" }) };
    const [items, total] = await Promise.all([
      Coupon.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Coupon.countDocuments(filter),
    ]);
    return { items: items.map(toCouponView), page: q.page, limit: q.limit, total };
  }

  async function create(req: Request) {
    const body = req.body as CouponInput;
    checkCoupon(body);
    const coupon = await Coupon.create({
      ...body,
      ...scopeOf(req),
      maxDiscount: body.maxDiscount ?? undefined,
      startsAt: body.startsAt ?? undefined,
      endsAt: body.endsAt ?? undefined,
      usageLimit: body.usageLimit ?? undefined,
      description: body.description || undefined,
      createdBy: req.auth!.id,
    }).catch(codeTaken);
    return { coupon: toCouponView(coupon) };
  }

  async function update(req: Request) {
    const coupon = await Coupon.findOne({ _id: idParam(req), ...scopeOf(req) });
    if (!coupon) throw new AppError(404, "not_found", "Coupon not found");
    const changes = req.body as z.infer<typeof updateSchema>;
    const merged = { ...toCouponView(coupon), ...changes } as unknown as CouponInput;
    checkCoupon({ ...merged, startsAt: merged.startsAt ? new Date(merged.startsAt) : null, endsAt: merged.endsAt ? new Date(merged.endsAt) : null });
    for (const [key, value] of Object.entries(changes)) {
      coupon.set(key, value === null || value === "" ? undefined : value);
    }
    await coupon.save();
    return { coupon: toCouponView(coupon as CouponDoc) };
  }

  router.get("/admin/coupons", ...admin, async (req, res) => res.json(await list(req)));
  router.post("/admin/coupons", ...admin, validateBody(createSchema), async (req, res) => res.status(201).json(await create(req)));
  router.patch("/admin/coupons/:id", ...admin, validateBody(updateSchema), async (req, res) => res.json(await update(req)));

  router.get("/vendor/coupons", ...seller, async (req, res) => res.json(await list(req)));
  router.post("/vendor/coupons", ...seller, validateBody(createSchema), async (req, res) => res.status(201).json(await create(req)));
  router.patch("/vendor/coupons/:id", ...seller, validateBody(updateSchema), async (req, res) => res.json(await update(req)));

  return router;
}
