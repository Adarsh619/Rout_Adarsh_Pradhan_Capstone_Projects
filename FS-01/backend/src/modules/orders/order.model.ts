import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ORDER_STATUSES = ["pending_payment", "confirmed", "completed", "cancelled", "expired"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

// awaiting_payment exists only until the order is paid; vendors never see sub-orders in that state.
export const SUB_ORDER_STATUSES = ["awaiting_payment", "placed", "packed", "shipped", "delivered", "cancelled"] as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = ["created", "paid", "failed", "refunded", "partially_refunded"] as const;
export const PAYOUT_STATUSES = ["held", "released", "paid", "reversed", "failed"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const REFUND_STATUSES = ["pending", "processed", "failed"] as const;
export const ACTOR_ROLES =["customer", "vendor", "admin", "system"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

// One product line, copied at purchase time: later price or title changes never alter a placed order.
const lineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    title: { type: String, required: true },
    imageKey: { type: String },
    price: { type: Number, required: true },
    qty: { type: Number, required: true, min: 1 },
    // Frozen at purchase: vendor override ?? category ?? parent category ?? platform default.
    commissionRateBp: { type: Number, required: true },
  },
  { _id: false },
);

const addressSnapshot = new Schema(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    line1: { type: String, required: true },
    line2: { type: String },
    city: { type: String, required: true },
    state: { type: String, required: true },
    pincode: { type: String, required: true },
  },
  { _id: false },
);

const orderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    items: { type: [lineSchema], required: true },
    shippingAddress: { type: addressSnapshot, required: true },
    // Money in paise. grandTotal = itemsTotal − discount + shipping (coupons arrive on Day 7, shipping is free).
    itemsTotal: { type: Number, required: true },
    discount: { type: Number, default: 0 },
    shipping: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true },
    payment: {
      provider: { type: String, enum: ["mock", "razorpay"], required: true },
      providerOrderId: { type: String },
      providerPaymentId: { type: String },
      status: { type: String, enum: PAYMENT_STATUSES, default: "created" },
      paidAt: { type: Date },
      // Sum of the refunds made so far (cancelled parts, or the whole payment if it arrived too late).
      refundedAmount: { type: Number, default: 0 },
    },
    status: { type: String, enum: ORDER_STATUSES, default: "pending_payment" },
    // Reserved stock goes back on sale if the order isn't paid by then.
    reservationExpiresAt: { type: Date, required: true },
    cancelledAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

orderSchema.index({ customerId: 1, createdAt: -1 });
orderSchema.index({ "payment.providerOrderId": 1 }, { unique: true, partialFilterExpression: { "payment.providerOrderId": { $type: "string" } } });
// The expiry sweep: unpaid orders whose reservation has run out.
orderSchema.index({ status: 1, reservationExpiresAt: 1 });
// "Has this product ever been ordered?" (it can't be deleted then).
orderSchema.index({ "items.productId": 1 });

export type OrderDoc = HydratedDocument<InferSchemaType<typeof orderSchema>>;
export const Order = model("Order", orderSchema);

const historySchema = new Schema(
  {
    status: { type: String, enum: SUB_ORDER_STATUSES, required: true },
    at: { type: Date, required: true },
    byUserId: { type: Schema.Types.ObjectId, ref: "User" },
    byRole: { type: String, enum: ACTOR_ROLES, required: true },
    note: { type: String, maxlength: 300 },
  },
  { _id: false },
);

// One per store per order: each vendor packs, ships and gets paid for their own part independently.
const subOrderSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    orderNumber: { type: String, required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    // Snapshot of the store's name, so the order reads the same even if the store is renamed.
    vendorName: { type: String, required: true },
    vendorSlug: { type: String, required: true },
    items: { type: [lineSchema], required: true },
    itemsTotal: { type: Number, required: true },
    discountShare: { type: Number, default: 0 },
    // What the customer paid for this part: itemsTotal − discountShare.
    payable: { type: Number, required: true },
    commission: { type: Number, required: true },
    // What the vendor receives once the part is delivered (escrow and payouts: Day 6).
    vendorNet: { type: Number, required: true },
    status: { type: String, enum: SUB_ORDER_STATUSES, default: "awaiting_payment" },
    statusHistory: { type: [historySchema], default: [] },
    tracking: {
      carrier: { type: String, maxlength: 60 },
      number: { type: String, maxlength: 60 },
    },
    // The vendor's share in escrow: held when paid → released on delivery → paid out; or reversed if cancelled.
    payout: {
      amount: { type: Number },
      status: { type: String, enum: PAYOUT_STATUSES },
      provider: { type: String },
      providerRef: { type: String },
      releasedAt: { type: Date },
      paidAt: { type: Date },
      lastError: { type: String },
    },
    // Money back to the customer for a cancelled part (through Razorpay).
    refund: {
      amount: { type: Number },
      status: { type: String, enum: REFUND_STATUSES },
      providerRef: { type: String },
      requestedAt: { type: Date },
      processedAt: { type: Date },
      lastError: { type: String },
    },
    // Set when the order is paid: from then on the vendor sees this part.
    placedAt: { type: Date },
    deliveredAt: { type: Date },
    cancelledAt: { type: Date },
    cancelReason: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);

subOrderSchema.index({ vendorId: 1, status: 1, createdAt: -1 });
subOrderSchema.index({ vendorId: 1, placedAt: -1 });
// Shares waiting to be paid out (e.g. once a vendor adds payout details).
subOrderSchema.index({ "payout.status": 1, vendorId: 1 });

export type SubOrderDoc = HydratedDocument<InferSchemaType<typeof subOrderSchema>>;
export const SubOrder = model("SubOrder", subOrderSchema);

// Sequential order numbers per year (SS-2026-000123). Taken outside the checkout transaction, so a failed checkout
// leaves a gap rather than making every checkout wait on one counter document.
const counterSchema = new Schema({ _id: { type: String, required: true }, seq: { type: Number, default: 0 } });
export const Counter = model("Counter", counterSchema);

export async function nextOrderNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const counter = await Counter.findOneAndUpdate({ _id: `order-${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return formatOrderNumber(year, counter.seq);
}

export const formatOrderNumber = (year: number, seq: number) => `SS-${year}-${String(seq).padStart(6, "0")}`;
