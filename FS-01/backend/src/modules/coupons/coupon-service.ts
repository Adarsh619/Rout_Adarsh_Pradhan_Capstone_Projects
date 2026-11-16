import { prisma, type Tx } from "../../lib/db.js";
import { AppError } from "../../middleware/errors.js";
import type { VendorPart } from "../orders/order-rules.js";
import { couponProblem, type CouponTerms } from "./coupon-rules.js";
import type { CouponRow } from "./coupon.model.js";

// The code applied to a cart lives next to the cart in Redis and expires with it.
export const couponKeyFor = (cartKey: string) => `${cartKey}:coupon`;

export const normaliseCode = (code: string) => code.trim().toUpperCase();

export const termsOf = (c: CouponRow): CouponTerms => ({
  scope: c.scope,
  vendorId: c.vendorId,
  type: c.type,
  value: c.value,
  maxDiscount: c.maxDiscount,
  minOrder: c.minOrder,
});

// Looks a code up and checks it against these parts of a cart; `problem` says why it can't be used, if it can't.
export async function evaluateCoupon(code: string, userId: string | undefined, parts: Pick<VendorPart, "vendorId" | "itemsTotal">[], now = new Date()) {
  const coupon = await prisma.coupon.findUnique({ where: { code: normaliseCode(code) } });
  if (!coupon) return { coupon: null, problem: "This code isn't valid." };
  const usedByThisCustomer = userId ? await prisma.couponRedemption.count({ where: { couponId: coupon.id, userId } }) : 0;
  const problem = couponProblem({ ...termsOf(coupon), isActive: coupon.isActive, startsAt: coupon.startsAt, endsAt: coupon.endsAt, usageLimit: coupon.usageLimit, usedCount: coupon.usedCount, perUserLimit: coupon.perUserLimit }, {
    now,
    usedByThisCustomer,
    parts,
  });
  return { coupon, problem };
}

// What the shopper sees about an applied coupon.
export async function couponSummary(coupon: CouponRow) {
  const store = coupon.vendorId ? await prisma.vendor.findUnique({ where: { id: coupon.vendorId }, select: { storeName: true } }) : null;
  return {
    code: coupon.code,
    description: coupon.description,
    scope: coupon.scope,
    storeName: store?.storeName ?? null,
  };
}

// Takes one use of the coupon inside the checkout transaction: only while below its overall limit and the customer's
// own limit, so two checkouts can't both take the last use. The conditional update locks the coupon's row until the
// transaction ends, so the per-customer count below can't race either.
export async function redeem(coupon: CouponRow, userId: string, orderId: string, tx: Tx) {
  const taken = await tx.coupon.updateMany({
    where: { id: coupon.id, isActive: true, ...(coupon.usageLimit && { usedCount: { lt: coupon.usageLimit } }) },
    data: { usedCount: { increment: 1 } },
  });
  if (taken.count !== 1) throw new AppError(409, "coupon_exhausted", "This coupon has just been used up. Remove it to continue.");
  const mine = await tx.couponRedemption.count({ where: { couponId: coupon.id, userId } });
  if (mine >= coupon.perUserLimit) throw new AppError(409, "coupon_invalid", "You've already used this coupon.");
  await tx.couponRedemption.create({ data: { couponId: coupon.id, userId, orderId } });
}

// The order was never paid: give the use back.
export async function releaseRedemption(couponId: string, orderId: string, tx: Tx) {
  const removed = await tx.couponRedemption.deleteMany({ where: { couponId, orderId } });
  if (removed.count === 1) await tx.coupon.updateMany({ where: { id: couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
}
