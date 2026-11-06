import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

// A discount code. Platform coupons are paid for by the platform (vendors still get their full share); vendor coupons
// are paid for by that store and only discount its items.
const couponSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    scope: { type: String, enum: ["platform", "vendor"], required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor" },
    // percent: value in basis points (1000 = 10%); flat: value in paise.
    type: { type: String, enum: ["percent", "flat"], required: true },
    value: { type: Number, required: true, min: 1 },
    // Largest discount a percent coupon can give, in paise.
    maxDiscount: { type: Number, min: 1 },
    // Smallest order it applies to, in paise (for a vendor coupon: that store's items only).
    minOrder: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date },
    endsAt: { type: Date },
    // Total uses across all customers (unset = unlimited) and uses per customer.
    usageLimit: { type: Number, min: 1 },
    perUserLimit: { type: Number, default: 1, min: 1 },
    // Raised atomically at checkout, only while below usageLimit; given back if the order is never paid.
    usedCount: { type: Number, default: 0, min: 0 },
    isActive: { type: Boolean, default: true },
    description: { type: String, trim: true, maxlength: 140 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

couponSchema.index({ scope: 1, vendorId: 1, createdAt: -1 });

export type CouponDoc = HydratedDocument<InferSchemaType<typeof couponSchema>>;
export const Coupon = model("Coupon", couponSchema);

// Who used which coupon on which order: counts towards the per-customer limit, and is removed (with the use given
// back) if the order expires or is cancelled before payment.
const redemptionSchema = new Schema(
  {
    couponId: { type: Schema.Types.ObjectId, ref: "Coupon", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
redemptionSchema.index({ couponId: 1, orderId: 1 }, { unique: true });
redemptionSchema.index({ couponId: 1, userId: 1 });

export const CouponRedemption = model("CouponRedemption", redemptionSchema);

export const toCouponView = (c: CouponDoc) => ({
  id: c.id as string,
  code: c.code,
  scope: c.scope as "platform" | "vendor",
  vendorId: c.vendorId ? c.vendorId.toString() : null,
  type: c.type as "percent" | "flat",
  value: c.value,
  maxDiscount: c.maxDiscount ?? null,
  minOrder: c.minOrder,
  startsAt: c.startsAt ? c.startsAt.toISOString() : null,
  endsAt: c.endsAt ? c.endsAt.toISOString() : null,
  usageLimit: c.usageLimit ?? null,
  perUserLimit: c.perUserLimit,
  usedCount: c.usedCount,
  isActive: c.isActive,
  description: c.description ?? null,
  createdAt: (c.createdAt as Date).toISOString(),
});
