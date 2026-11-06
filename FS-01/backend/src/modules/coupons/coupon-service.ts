import type { ClientSession, Types } from "mongoose";
import { AppError } from "../../middleware/errors.js";
import type { VendorPart } from "../orders/order-rules.js";
import { Vendor } from "../vendors/vendor.model.js";
import { couponProblem, type CouponTerms } from "./coupon-rules.js";
import { Coupon, CouponRedemption, type CouponDoc } from "./coupon.model.js";

// The code applied to a cart lives next to the cart in Redis and expires with it.
export const couponKeyFor = (cartKey: string) => `${cartKey}:coupon`;

export const normaliseCode = (code: string) => code.trim().toUpperCase();

export const termsOf = (c: CouponDoc): CouponTerms => ({
  scope: c.scope as "platform" | "vendor",
  vendorId: c.vendorId ? c.vendorId.toString() : null,
  type: c.type as "percent" | "flat",
  value: c.value,
  maxDiscount: c.maxDiscount ?? null,
  minOrder: c.minOrder,
});

// Looks a code up and checks it against these parts of a cart; `problem` says why it can't be used, if it can't.
export async function evaluateCoupon(code: string, userId: string | undefined, parts: Pick<VendorPart, "vendorId" | "itemsTotal">[], now = new Date()) {
  const coupon = await Coupon.findOne({ code: normaliseCode(code) });
  if (!coupon) return { coupon: null, problem: "This code isn't valid." };
  const usedByThisCustomer = userId ? await CouponRedemption.countDocuments({ couponId: coupon._id, userId }) : 0;
  const problem = couponProblem({ ...termsOf(coupon), isActive: coupon.isActive, startsAt: coupon.startsAt, endsAt: coupon.endsAt, usageLimit: coupon.usageLimit, usedCount: coupon.usedCount, perUserLimit: coupon.perUserLimit }, {
    now,
    usedByThisCustomer,
    parts,
  });
  return { coupon, problem };
}

// What the shopper sees about an applied coupon.
export async function couponSummary(coupon: CouponDoc) {
  const store = coupon.vendorId ? await Vendor.findById(coupon.vendorId).select("storeName") : null;
  return {
    code: coupon.code,
    description: coupon.description ?? null,
    scope: coupon.scope as "platform" | "vendor",
    storeName: store?.storeName ?? null,
  };
}

// Takes one use of the coupon inside the checkout transaction: only while below its overall limit and the customer's
// own limit, so two checkouts can't both take the last use.
export async function redeem(coupon: CouponDoc, userId: string, orderId: Types.ObjectId, session: ClientSession) {
  const taken = await Coupon.updateOne(
    {
      _id: coupon._id,
      isActive: true,
      ...(coupon.usageLimit && { usedCount: { $lt: coupon.usageLimit } }),
    },
    { $inc: { usedCount: 1 } },
    { session },
  );
  if (taken.modifiedCount !== 1) throw new AppError(409, "coupon_exhausted", "This coupon has just been used up. Remove it to continue.");
  const mine = await CouponRedemption.countDocuments({ couponId: coupon._id, userId }).session(session);
  if (mine >= coupon.perUserLimit) throw new AppError(409, "coupon_invalid", "You've already used this coupon.");
  await CouponRedemption.create([{ couponId: coupon._id, userId, orderId }], { session });
}

// The order was never paid: give the use back.
export async function releaseRedemption(couponId: Types.ObjectId, orderId: Types.ObjectId, session: ClientSession) {
  const removed = await CouponRedemption.deleteOne({ couponId, orderId }, { session });
  if (removed.deletedCount === 1) await Coupon.updateOne({ _id: couponId, usedCount: { $gt: 0 } }, { $inc: { usedCount: -1 } }, { session });
}
