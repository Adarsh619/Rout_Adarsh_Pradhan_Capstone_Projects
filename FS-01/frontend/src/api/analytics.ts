import { useQuery } from "@tanstack/react-query";
import { queryString, type OwnStore, type Page } from "./catalog";
import { api } from "./client";

export interface Range {
  from?: string;
  to?: string;
}

export interface Escrow {
  held: number;
  released: number;
  paid: number;
  reversed: number;
  counts: { held: number; released: number; paid: number; reversed: number };
}

export interface AdminAnalytics {
  range: { from: string; to: string };
  totals: {
    gmv: number;
    cancelledValue: number;
    collected: number;
    refunds: number;
    paidOrders: number;
    averageOrderValue: number;
    commission: number;
    platformDiscounts: number;
    platformRevenue: number;
    payoutsSent: number;
  };
  ordersByStatus: Record<string, number>;
  partsByStatus: Record<string, number>;
  daily: { day: string; sales: number; orders: number }[];
  topVendors: { vendorId: string; storeName: string; slug: string; sales: number; orders: number; commission: number }[];
  topProducts: { productId: string; title: string; storeName: string; units: number; sales: number }[];
  escrow: Escrow;
  failingRefunds: number;
  // Refunds promised but not yet made: still owed to customers.
  refundsOwed: number;
}

export interface VendorEarnings extends Page<{
  id: string;
  orderNumber: string;
  placedAt: string | null;
  status: string;
  itemsTotal: number;
  discountShare: number;
  commission: number;
  vendorNet: number;
  payout: { status: string | null; paidAt: string | null; reference: string | null };
}> {
  range: { from: string; to: string };
  totals: { sales: number; couponDiscounts: number; commission: number; net: number; orders: number };
  escrow: Escrow;
  daily: { day: string; net: number; orders: number }[];
  payoutAccount: boolean;
}

export const useAdminAnalytics = (range: Range) =>
  useQuery({
    queryKey: ["admin", "analytics", range],
    queryFn: () => api<AdminAnalytics>(`/admin/analytics${queryString({ ...range })}`),
    placeholderData: (previous) => previous,
  });

export const useVendorEarnings = (range: Range, page: number) =>
  useQuery({
    queryKey: ["vendor", "earnings", range, page],
    queryFn: () => api<VendorEarnings>(`/vendor/earnings${queryString({ ...range, page, limit: 10 })}`),
    placeholderData: (previous) => previous,
  });

// ---- Admin tools -------------------------------------------------------------------------------------

export interface AdminOrder {
  id: string;
  orderNumber: string;
  status: string;
  createdAt: string;
  grandTotal: number;
  discount: number;
  coupon: string | null;
  payment: { provider: string; status: string; refundedAmount: number; reference: string | null };
  customer: { name: string; email: string };
  parts: {
    id: string;
    storeName: string;
    status: string;
    payable: number;
    payout: string | null;
    refund: { amount: number; status: string; lastError: string | null } | null;
    canRefund: boolean;
  }[];
}

export const useAdminOrders = (params: { q?: string; refund?: string; page: number }) =>
  useQuery({
    queryKey: ["admin", "orders", params],
    queryFn: () => api<Page<AdminOrder>>(`/admin/orders${queryString({ ...params, limit: 10 })}`),
    placeholderData: (previous) => previous,
  });

export const refundPart = (subId: string, reason: string) =>
  api(`/admin/sub-orders/${subId}/refund`, { method: "POST", body: JSON.stringify({ reason }) });

export const retryRefund = (subId: string) =>
  api<{ refund: { status: string; lastError: string | null } }>(`/admin/sub-orders/${subId}/refund/retry`, { method: "POST" });

export const setVendorCommission = (vendorId: string, commissionRateBp: number | null) =>
  api<{ store: OwnStore }>(`/admin/vendors/${vendorId}/commission`, { method: "PATCH", body: JSON.stringify({ commissionRateBp }) });

export const setCategoryCommission = (categoryId: string, commissionRateBp: number | null) =>
  api(`/admin/categories/${categoryId}`, { method: "PATCH", body: JSON.stringify({ commissionRateBp }) });

export interface AdminReview {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  verified: boolean;
  createdAt: string;
  status: "visible" | "hidden";
  hiddenReason: string | null;
  product: { id: string; title: string };
}

export const useAdminReviews = (params: { status?: "visible" | "hidden"; page: number }) =>
  useQuery({
    queryKey: ["admin", "reviews", params],
    queryFn: () => api<Page<AdminReview>>(`/admin/reviews${queryString({ ...params, limit: 20 })}`),
    placeholderData: (previous) => previous,
  });

export const moderateReview = (id: string, status: "visible" | "hidden", reason?: string) =>
  api(`/admin/reviews/${id}`, { method: "PATCH", body: JSON.stringify({ status, reason }) });
