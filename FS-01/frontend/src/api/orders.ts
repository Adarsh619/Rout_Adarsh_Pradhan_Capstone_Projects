import { useQuery } from "@tanstack/react-query";
import { queryString, type Page } from "./catalog";
import { api } from "./client";

// ---- Addresses ---------------------------------------------------------------------------------

export interface Address {
  id: string;
  label: string | null;
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

export type AddressInput = Omit<Address, "id" | "label" | "line2"> & { label: string; line2: string };

export const addressesKey = ["account", "addresses"];

export const useAddresses = () =>
  useQuery({ queryKey: addressesKey, queryFn: () => api<{ items: Address[] }>("/account/addresses").then((r) => r.items) });

export const addAddress = (input: AddressInput) =>
  api<{ address: Address; items: Address[] }>("/account/addresses", { method: "POST", body: JSON.stringify(input) });

export const deleteAddress = (id: string) => api<{ items: Address[] }>(`/account/addresses/${id}`, { method: "DELETE" });

// ---- Orders ------------------------------------------------------------------------------------

export type OrderStatus = "pending_payment" | "confirmed" | "completed" | "cancelled" | "expired";
export type PartStatus = "awaiting_payment" | "placed" | "packed" | "shipped" | "delivered" | "cancelled";

export interface OrderLine {
  productId: string;
  title: string;
  image: string | null;
  price: number;
  qty: number;
  lineTotal: number;
}

export interface TimelineEntry {
  status: PartStatus;
  at: string;
  byRole: "customer" | "vendor" | "admin" | "system";
  note: string | null;
}

export interface ShippingAddress {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
}

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
  itemsTotal: number;
  discount: number;
  shipping: number;
  grandTotal: number;
  payment: { provider: "mock" | "razorpay"; status: string; paidAt: string | null; refundedAmount: number; providerOrderId: string | null };
  reservationExpiresAt: string | null;
  shippingAddress: ShippingAddress;
  parts: {
    id: string;
    vendor: { storeName: string; slug: string };
    items: OrderLine[];
    itemsTotal: number;
    payable: number;
    status: PartStatus;
    tracking: { carrier: string; number: string } | null;
    timeline: TimelineEntry[];
    canCancel: boolean;
    cancelReason: string | null;
    refund: { amount: number; status: "pending" | "processed" | "failed" } | null;
  }[];
}

export interface PaymentStep {
  provider: "mock" | "razorpay";
  providerOrderId: string;
  amount: number;
  currency: "INR";
  expiresAt: string;
  // Razorpay's public key id, to open its popup (only when provider is "razorpay").
  keyId?: string;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  createdAt: string;
  grandTotal: number;
  itemCount: number;
  image: string | null;
  title: string;
  parts: { storeName: string; status: PartStatus }[];
}

export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  pending_payment: "Waiting for payment",
  confirmed: "Confirmed",
  completed: "Completed",
  cancelled: "Cancelled",
  expired: "Expired (not paid)",
};

export const PART_STATUS_LABEL: Record<PartStatus, string> = {
  awaiting_payment: "Waiting for payment",
  placed: "Order placed",
  packed: "Packed",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export const placeOrder = (input: { addressId: string; expectedTotal: number }) =>
  api<{ order: Order; payment: PaymentStep }>("/checkout", { method: "POST", body: JSON.stringify(input) });

// The test payment screen (PAYMENT_PROVIDER=mock): the server plays Razorpay and signs the payment.
export const mockPay = (providerOrderId: string, outcome: "success" | "failure") =>
  api<{ providerOrderId: string; providerPaymentId: string; signature: string }>("/payments/mock/pay", {
    method: "POST",
    body: JSON.stringify({ providerOrderId, outcome }),
  });

export const verifyPayment = (input: { orderId: string; providerOrderId: string; providerPaymentId: string; signature: string }) =>
  api<{ order: Order }>("/checkout/verify", { method: "POST", body: JSON.stringify(input) });

export const orderKey = (id: string) => ["orders", id];

export const useMyOrders = (page: number) =>
  useQuery({
    queryKey: ["orders", "list", page],
    queryFn: () => api<Page<OrderSummary>>(`/orders${queryString({ page, limit: 10 })}`),
    placeholderData: (previous) => previous,
  });

export const useOrder = (id: string) =>
  useQuery({ queryKey: orderKey(id), queryFn: () => api<{ order: Order; payment: PaymentStep | null }>(`/orders/${id}`) });

export const cancelUnpaidOrder = (id: string) => api<{ order: Order }>(`/orders/${id}/cancel`, { method: "POST" });

export const cancelPart = (orderId: string, partId: string, reason?: string) =>
  api<{ order: Order }>(`/orders/${orderId}/sub-orders/${partId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });

// ---- The vendor's side -------------------------------------------------------------------------

export type VendorPartStatus = Exclude<PartStatus, "awaiting_payment">;

export interface VendorPart {
  id: string;
  orderNumber: string;
  status: VendorPartStatus;
  placedAt: string | null;
  items: OrderLine[];
  itemsTotal: number;
  payable: number;
  commission: number;
  vendorNet: number;
  customer: { name: string };
  shippingAddress: ShippingAddress | null;
  tracking: { carrier: string; number: string } | null;
  timeline: TimelineEntry[];
  nextStatus: "packed" | "shipped" | "delivered" | null;
  cancelReason: string | null;
  payout: { status: PayoutStatus; amount: number; releasedAt: string | null; paidAt: string | null; reference: string | null } | null;
}

export type PayoutStatus = "held" | "released" | "paid" | "reversed" | "failed";

export const PAYOUT_TEXT: Record<PayoutStatus, string> = {
  held: "Held until delivery",
  released: "Released, being paid out",
  paid: "Paid out (simulated)",
  reversed: "Cancelled, not payable",
  failed: "Payout failed, retrying",
};

export const useVendorOrders = (params: { status?: VendorPartStatus; page: number }) =>
  useQuery({
    queryKey: ["vendor", "orders", params],
    queryFn: () => api<Page<VendorPart> & { counts: Record<VendorPartStatus, number> }>(`/vendor/orders${queryString({ ...params, limit: 20 })}`),
    placeholderData: (previous) => previous,
  });

export const advancePart = (id: string, status: "packed" | "shipped" | "delivered", tracking?: { carrier: string; number: string }) =>
  api<{ part: VendorPart }>(`/vendor/orders/${id}/status`, { method: "POST", body: JSON.stringify({ status, tracking }) });
