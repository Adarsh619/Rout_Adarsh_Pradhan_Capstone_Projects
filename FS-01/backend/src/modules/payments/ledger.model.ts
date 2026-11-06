import { model, Schema, type ClientSession, type Types } from "mongoose";

// Every money movement, append-only: entries are never changed or deleted, a correction is a new entry.
// Amounts are positive paise; the type says what happened. Vendor earnings and admin analytics are sums over it.
export const LEDGER_TYPES = [
  "payment", // the customer paid the order (order level)
  "refund", // money returned to the customer for one part
  "commission", // the platform's commission on one part
  "commission_reversal", // that commission given up because the part was cancelled
  "vendor_hold", // the vendor's share, held until the part is delivered
  "vendor_release", // the part was delivered: the share can be paid out
  "vendor_reversal", // the part was cancelled before delivery: the held share is cancelled
  "payout", // the share was paid to the vendor (simulated provider in v1)
  "platform_discount", // a platform coupon: the platform pays this much of the customer's price (order level)
  "platform_discount_reversal", // a part with a platform discount was cancelled: that share of the discount is undone
] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

const ledgerSchema = new Schema(
  {
    // One entry of each type per part (or per order for the payment), enforced by this key, so a retried job or a
    // repeated webhook can never record the same movement twice.
    key: { type: String, required: true, unique: true },
    type: { type: String, enum: LEDGER_TYPES, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    subOrderId: { type: Schema.Types.ObjectId, ref: "SubOrder" },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor" },
    amount: { type: Number, required: true, min: 0 },
    // Razorpay payment or refund id, or the payout reference.
    providerRef: { type: String },
    note: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

ledgerSchema.index({ vendorId: 1, type: 1, createdAt: -1 });
ledgerSchema.index({ type: 1, createdAt: -1 });

export const LedgerEntry = model("LedgerEntry", ledgerSchema);

export interface LedgerInput {
  type: LedgerType;
  orderId: Types.ObjectId | string;
  subOrderId?: Types.ObjectId | string;
  vendorId?: Types.ObjectId | string;
  amount: number;
  providerRef?: string;
  note?: string;
}

export const ledgerKey = (e: Pick<LedgerInput, "type" | "orderId" | "subOrderId">) => `${e.type}:${String(e.subOrderId ?? e.orderId)}`;

export async function record(entries: LedgerInput[], session?: ClientSession): Promise<void> {
  if (entries.length === 0) return;
  await LedgerEntry.insertMany(
    entries.map((e) => ({ ...e, key: ledgerKey(e) })),
    { session, ordered: true },
  );
}
