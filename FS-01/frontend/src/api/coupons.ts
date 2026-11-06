import { useQuery } from "@tanstack/react-query";
import { queryString, type Page } from "./catalog";
import { api } from "./client";

export interface Coupon {
  id: string;
  code: string;
  scope: "platform" | "vendor";
  vendorId: string | null;
  type: "percent" | "flat";
  // percent: basis points (1000 = 10%); flat: paise.
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  perUserLimit: number;
  usedCount: number;
  isActive: boolean;
  description: string | null;
  createdAt: string;
}

export interface CouponInput {
  code: string;
  type: "percent" | "flat";
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  endsAt: string | null;
  usageLimit: number | null;
  perUserLimit: number;
  description: string;
}

// Admins manage platform coupons at /admin/coupons, vendors their own store's at /vendor/coupons.
export type CouponOwner = "admin" | "vendor";

export const couponsKey = (owner: CouponOwner) => [owner, "coupons"];

export const useCoupons = (owner: CouponOwner, page: number) =>
  useQuery({
    queryKey: [...couponsKey(owner), page],
    queryFn: () => api<Page<Coupon>>(`/${owner}/coupons${queryString({ page, limit: 20 })}`),
    placeholderData: (previous) => previous,
  });

export const createCoupon = (owner: CouponOwner, input: CouponInput) =>
  api<{ coupon: Coupon }>(`/${owner}/coupons`, { method: "POST", body: JSON.stringify(input) }).then((r) => r.coupon);

export const updateCoupon = (owner: CouponOwner, id: string, changes: Partial<Omit<CouponInput, "code">> & { isActive?: boolean }) =>
  api<{ coupon: Coupon }>(`/${owner}/coupons/${id}`, { method: "PATCH", body: JSON.stringify(changes) }).then((r) => r.coupon);

export const describeCoupon = (c: Pick<Coupon, "type" | "value" | "maxDiscount" | "minOrder">, format: (paise: number) => string) => {
  const off = c.type === "percent" ? `${c.value / 100}% off` : `${format(c.value)} off`;
  const cap = c.type === "percent" && c.maxDiscount ? `, up to ${format(c.maxDiscount)}` : "";
  const min = c.minOrder > 0 ? ` on ${format(c.minOrder)} or more` : "";
  return `${off}${cap}${min}`;
};
