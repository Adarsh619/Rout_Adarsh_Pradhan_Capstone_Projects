import type { Coupon as CouponRow } from "../../generated/prisma/client.js";

export type { CouponRow };

export const toCouponView = (c: CouponRow) => ({
  id: c.id,
  code: c.code,
  scope: c.scope,
  vendorId: c.vendorId,
  type: c.type,
  value: c.value,
  maxDiscount: c.maxDiscount,
  minOrder: c.minOrder,
  startsAt: c.startsAt ? c.startsAt.toISOString() : null,
  endsAt: c.endsAt ? c.endsAt.toISOString() : null,
  usageLimit: c.usageLimit,
  perUserLimit: c.perUserLimit,
  usedCount: c.usedCount,
  isActive: c.isActive,
  description: c.description,
  createdAt: c.createdAt.toISOString(),
});
