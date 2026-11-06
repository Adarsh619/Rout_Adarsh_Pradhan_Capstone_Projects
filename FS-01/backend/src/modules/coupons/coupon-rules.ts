import type { PricedLine, VendorPart } from "../orders/order-rules.js";

// Pure coupon maths, kept apart from the database so every rule can be unit-tested. All amounts in paise.

export interface CouponTerms {
  scope: "platform" | "vendor";
  vendorId?: string | null;
  type: "percent" | "flat";
  value: number;
  maxDiscount?: number | null;
  minOrder: number;
}

export interface CouponState {
  isActive: boolean;
  startsAt?: Date | null;
  endsAt?: Date | null;
  usageLimit?: number | null;
  usedCount: number;
  perUserLimit: number;
}

// Why a coupon can't be used right now, in words a shopper understands; null if it can.
export function couponProblem(c: CouponState & CouponTerms, ctx: { now: Date; usedByThisCustomer: number; parts: { vendorId: string; itemsTotal: number }[] }): string | null {
  if (!c.isActive) return "This coupon is no longer active.";
  if (c.startsAt && ctx.now < c.startsAt) return "This coupon isn't valid yet.";
  if (c.endsAt && ctx.now > c.endsAt) return "This coupon has expired.";
  if (c.usageLimit && c.usedCount >= c.usageLimit) return "This coupon has been fully used.";
  if (ctx.usedByThisCustomer >= c.perUserLimit) return c.perUserLimit === 1 ? "You've already used this coupon." : `You've already used this coupon ${c.perUserLimit} times.`;
  const base = baseFor(c, ctx.parts);
  if (c.scope === "vendor" && base === 0) return "This coupon is for a store that has nothing in your cart.";
  if (base < c.minOrder) return `Add items worth ${rupees(c.minOrder - base)} more to use this coupon${c.scope === "vendor" ? " (from this store)" : ""}.`;
  return null;
}

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

// What the coupon discounts: the whole cart, or only the coupon's store.
function baseFor(c: CouponTerms, parts: { vendorId: string; itemsTotal: number }[]) {
  return c.scope === "vendor" ? (parts.find((p) => p.vendorId === String(c.vendorId))?.itemsTotal ?? 0) : parts.reduce((n, p) => n + p.itemsTotal, 0);
}

// The discount on a base amount: a percentage (rounded to the paisa, capped at maxDiscount) or a flat amount,
// never more than the base itself.
export function discountOn(c: Pick<CouponTerms, "type" | "value" | "maxDiscount">, base: number): number {
  const raw = c.type === "percent" ? Math.round((base * c.value) / 10_000) : c.value;
  return Math.max(0, Math.min(raw, c.maxDiscount ?? Infinity, base));
}

// Splits an amount across parts in proportion to their totals; the paise left over by rounding go to the largest part,
// so the shares always add up exactly.
export function allocate(amount: number, weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0 || amount === 0) return weights.map(() => 0);
  const shares = weights.map((w) => Math.floor((amount * w) / total));
  const largest = weights.indexOf(Math.max(...weights));
  shares[largest]! += amount - shares.reduce((a, b) => a + b, 0);
  return shares;
}

export interface DiscountedPart<L extends PricedLine = PricedLine> extends VendorPart<L> {
  discountShare: number;
  payable: number;
  discountBy: "platform" | "vendor" | null;
}

// Applies a coupon to the parts of an order (one per store):
// - platform coupon: the discount is split across parts by value and paid by the platform. Commission stays on each
//   part's full items total, so vendors get exactly what they would without the coupon. The discount is capped at the
//   total commission, so the platform never pays out more than it collects.
// - vendor coupon: only that store's part is discounted, and its commission is charged on what the customer actually
//   paid for it, so the store pays for its own coupon.
// Always: what the customer pays = Σ payable, and Σ payable + platform discount = Σ (vendorNet + commission).
export function applyCoupon<L extends PricedLine>(parts: VendorPart<L>[], coupon: CouponTerms | null): { parts: DiscountedPart<L>[]; discount: number; platformDiscount: number } {
  const plain = parts.map((p) => ({ ...p, discountShare: 0, payable: p.itemsTotal, discountBy: null }));
  if (!coupon) return { parts: plain, discount: 0, platformDiscount: 0 };

  if (coupon.scope === "platform") {
    const itemsTotal = parts.reduce((n, p) => n + p.itemsTotal, 0);
    const commission = parts.reduce((n, p) => n + p.commission, 0);
    const discount = Math.min(discountOn(coupon, itemsTotal), commission);
    const shares = allocate(
      discount,
      parts.map((p) => p.itemsTotal),
    );
    return {
      parts: parts.map((p, i) => ({ ...p, discountShare: shares[i]!, payable: p.itemsTotal - shares[i]!, discountBy: shares[i]! > 0 ? "platform" : null })),
      discount,
      platformDiscount: discount,
    };
  }

  const out = plain.map((p) => {
    if (p.vendorId !== String(coupon.vendorId)) return p;
    const share = discountOn(coupon, p.itemsTotal);
    const payable = p.itemsTotal - share;
    // The lines' commission, scaled to what was actually paid for them.
    const commission = p.itemsTotal === 0 ? 0 : Math.round((p.commission * payable) / p.itemsTotal);
    return { ...p, discountShare: share, payable, commission, vendorNet: payable - commission, discountBy: share > 0 ? ("vendor" as const) : null };
  });
  return { parts: out, discount: out.reduce((n, p) => n + p.discountShare, 0), platformDiscount: 0 };
}
