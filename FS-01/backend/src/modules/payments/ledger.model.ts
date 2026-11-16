import { prisma, type Tx } from "../../lib/db.js";

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

export interface LedgerInput {
  type: LedgerType;
  orderId: string;
  subOrderId?: string;
  vendorId?: string;
  amount: number;
  providerRef?: string;
  note?: string;
}

// One entry per type per part (or per order for order-level types), so a retried job can never book twice.
export const ledgerKey = (e: Pick<LedgerInput, "type" | "orderId" | "subOrderId">) => `${e.type}:${e.subOrderId ?? e.orderId}`;

// Append-only: entries are never updated or deleted. A repeated key fails the whole transaction (unique index).
export async function record(entries: LedgerInput[], tx: Tx = prisma): Promise<void> {
  if (entries.length === 0) return;
  await tx.ledgerEntry.createMany({ data: entries.map((e) => ({ ...e, key: ledgerKey(e) })) });
}
