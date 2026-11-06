import type { Storage } from "../../lib/s3.js";
import type { OrderDoc, SubOrderDoc, SubOrderStatus } from "./order.model.js";
import { canCustomerCancel, VENDOR_NEXT } from "./order-rules.js";

type Line = OrderDoc["items"][number];

const lineView = (l: Line, storage: Storage) => ({
  productId: l.productId.toString(),
  title: l.title,
  image: l.imageKey ? storage.publicUrl(l.imageKey) : null,
  price: l.price,
  qty: l.qty,
  lineTotal: l.price * l.qty,
});

const timeline = (s: SubOrderDoc) =>
  s.statusHistory.map((h) => ({ status: h.status as SubOrderStatus, at: (h.at as Date).toISOString(), byRole: h.byRole, note: h.note ?? null }));

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const address = (o: OrderDoc) => ({
  name: o.shippingAddress.name,
  phone: o.shippingAddress.phone,
  line1: o.shippingAddress.line1,
  line2: o.shippingAddress.line2 ?? null,
  city: o.shippingAddress.city,
  state: o.shippingAddress.state,
  pincode: o.shippingAddress.pincode,
});

// The customer's view of an order and its parts. Commission and vendor shares are never shown to customers.
export function toCustomerOrder(o: OrderDoc, parts: SubOrderDoc[], storage: Storage) {
  const pending = o.status === "pending_payment";
  return {
    id: o.id as string,
    orderNumber: o.orderNumber,
    status: o.status,
    createdAt: (o.createdAt as Date).toISOString(),
    itemsTotal: o.itemsTotal,
    discount: o.discount,
    shipping: o.shipping,
    grandTotal: o.grandTotal,
    payment: {
      provider: o.payment!.provider,
      status: o.payment!.status,
      paidAt: iso(o.payment!.paidAt),
      refundedAmount: o.payment!.refundedAmount ?? 0,
      // Needed to open the payment screen again while the order waits for payment.
      providerOrderId: pending ? (o.payment!.providerOrderId ?? null) : null,
    },
    reservationExpiresAt: pending ? o.reservationExpiresAt.toISOString() : null,
    shippingAddress: address(o),
    parts: parts.map((s) => ({
      id: s.id as string,
      vendor: { storeName: s.vendorName, slug: s.vendorSlug },
      items: s.items.map((l) => lineView(l, storage)),
      itemsTotal: s.itemsTotal,
      payable: s.payable,
      status: s.status as SubOrderStatus,
      tracking: s.tracking?.number ? { carrier: s.tracking.carrier ?? "", number: s.tracking.number } : null,
      timeline: timeline(s),
      canCancel: canCustomerCancel(s.status as SubOrderStatus),
      cancelReason: s.cancelReason ?? null,
      refund: s.refund?.amount ? { amount: s.refund.amount, status: s.refund.status ?? "pending" } : null,
    })),
  };
}

// A row in "My orders".
export function toOrderSummary(o: OrderDoc, parts: SubOrderDoc[], storage: Storage) {
  const first = o.items[0];
  return {
    id: o.id as string,
    orderNumber: o.orderNumber,
    status: o.status,
    createdAt: (o.createdAt as Date).toISOString(),
    grandTotal: o.grandTotal,
    itemCount: o.items.reduce((n, l) => n + l.qty, 0),
    image: first?.imageKey ? storage.publicUrl(first.imageKey) : null,
    title: first ? (o.items.length > 1 ? `${first.title} and ${o.items.length - 1} more` : first.title) : "",
    parts: parts.map((s) => ({ storeName: s.vendorName, status: s.status as SubOrderStatus })),
  };
}

// The vendor's view of their part: what to pack, where to send it, and what they'll earn.
export function toVendorPart(s: SubOrderDoc, order: OrderDoc | undefined, customerName: string | undefined, storage: Storage) {
  const status = s.status as SubOrderStatus;
  return {
    id: s.id as string,
    orderNumber: s.orderNumber,
    status,
    placedAt: iso(s.placedAt),
    items: s.items.map((l) => lineView(l, storage)),
    itemsTotal: s.itemsTotal,
    payable: s.payable,
    commission: s.commission,
    vendorNet: s.vendorNet,
    customer: { name: customerName ?? order?.shippingAddress.name ?? "" },
    shippingAddress: order ? address(order) : null,
    tracking: s.tracking?.number ? { carrier: s.tracking.carrier ?? "", number: s.tracking.number } : null,
    timeline: timeline(s),
    nextStatus: VENDOR_NEXT[status] ?? null,
    cancelReason: s.cancelReason ?? null,
    // Escrow: held until delivery, then released and paid out; reversed if the part is cancelled.
    payout: s.payout?.status
      ? { status: s.payout.status, amount: s.payout.amount ?? s.vendorNet, releasedAt: iso(s.payout.releasedAt), paidAt: iso(s.payout.paidAt), reference: s.payout.providerRef ?? null }
      : null,
  };
}
