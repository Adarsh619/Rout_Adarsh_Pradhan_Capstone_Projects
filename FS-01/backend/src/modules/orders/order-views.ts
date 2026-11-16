import type { Storage } from "../../lib/s3.js";
import { shippingAddressOf, type OrderLine, type OrderRow, type SubOrderRow } from "./order.model.js";
import { canCustomerCancel, VENDOR_NEXT } from "./order-rules.js";

const lineView = (l: OrderLine, storage: Storage) => ({
  productId: l.productId,
  title: l.title,
  image: l.imageKey ? storage.publicUrl(l.imageKey) : null,
  price: l.price,
  qty: l.qty,
  lineTotal: l.price * l.qty,
});

const timeline = (s: SubOrderRow) => s.history.map((h) => ({ status: h.status, at: h.at.toISOString(), byRole: h.byRole, note: h.note }));

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const address = (o: OrderRow) => {
  const a = shippingAddressOf(o);
  return { name: a.name, phone: a.phone, line1: a.line1, line2: a.line2 ?? null, city: a.city, state: a.state, pincode: a.pincode };
};

const tracking = (s: SubOrderRow) => (s.trackingNumber ? { carrier: s.trackingCarrier ?? "", number: s.trackingNumber } : null);

// The customer's view of an order and its parts. Commission and vendor shares are never shown to customers.
export function toCustomerOrder(o: OrderRow, parts: SubOrderRow[], storage: Storage) {
  const pending = o.status === "pending_payment";
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    itemsTotal: o.itemsTotal,
    discount: o.discount,
    shipping: o.shipping,
    grandTotal: o.grandTotal,
    coupon: o.couponCode && o.couponScope ? { code: o.couponCode, scope: o.couponScope } : null,
    payment: {
      provider: o.paymentProvider,
      status: o.paymentStatus,
      paidAt: iso(o.paidAt),
      refundedAmount: o.refundedAmount,
      // Needed to open the payment screen again while the order waits for payment.
      providerOrderId: pending ? o.paymentProviderOrderId : null,
    },
    reservationExpiresAt: pending ? o.reservationExpiresAt.toISOString() : null,
    shippingAddress: address(o),
    parts: parts.map((s) => ({
      id: s.id,
      vendor: { storeName: s.vendorName, slug: s.vendorSlug },
      items: s.lines.map((l) => lineView(l, storage)),
      itemsTotal: s.itemsTotal,
      discountShare: s.discountShare,
      payable: s.payable,
      status: s.status,
      tracking: tracking(s),
      timeline: timeline(s),
      invoiceNumber: s.invoiceNumber,
      // Reviews open once the part is delivered.
      canReview: s.status === "delivered",
      canCancel: canCustomerCancel(s.status),
      cancelReason: s.cancelReason,
      refund: s.refundAmount ? { amount: s.refundAmount, status: s.refundStatus ?? "pending" } : null,
    })),
  };
}

// A row in "My orders".
export function toOrderSummary(o: OrderRow, parts: Pick<SubOrderRow, "vendorName" | "status">[], storage: Storage) {
  const first = o.lines[0];
  return {
    id: o.id,
    orderNumber: o.orderNumber,
    status: o.status,
    createdAt: o.createdAt.toISOString(),
    grandTotal: o.grandTotal,
    itemCount: o.lines.reduce((n, l) => n + l.qty, 0),
    image: first?.imageKey ? storage.publicUrl(first.imageKey) : null,
    title: first ? (o.lines.length > 1 ? `${first.title} and ${o.lines.length - 1} more` : first.title) : "",
    parts: parts.map((s) => ({ storeName: s.vendorName, status: s.status })),
  };
}

// The vendor's view of their part: what to pack, where to send it, and what they'll earn.
export function toVendorPart(s: SubOrderRow, order: OrderRow | undefined, customerName: string | undefined, storage: Storage) {
  return {
    id: s.id,
    orderNumber: s.orderNumber,
    status: s.status,
    placedAt: iso(s.placedAt),
    items: s.lines.map((l) => lineView(l, storage)),
    itemsTotal: s.itemsTotal,
    discountShare: s.discountShare,
    discountBy: s.discountBy,
    payable: s.payable,
    commission: s.commission,
    invoiceNumber: s.invoiceNumber,
    vendorNet: s.vendorNet,
    customer: { name: customerName ?? (order ? shippingAddressOf(order).name : "") },
    shippingAddress: order ? address(order) : null,
    tracking: tracking(s),
    timeline: timeline(s),
    nextStatus: VENDOR_NEXT[s.status] ?? null,
    cancelReason: s.cancelReason,
    // Escrow: held until delivery, then released and paid out; reversed if the part is cancelled.
    payout: s.payoutStatus
      ? { status: s.payoutStatus, amount: s.payoutAmount ?? s.vendorNet, releasedAt: iso(s.payoutReleasedAt), paidAt: iso(s.payoutPaidAt), reference: s.payoutProviderRef }
      : null,
  };
}
