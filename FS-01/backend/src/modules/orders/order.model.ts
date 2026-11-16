import type { Order, OrderLine, Prisma, SubOrder, SubOrderEvent } from "../../generated/prisma/client.js";
import { nextSeq, type Tx } from "../../lib/db.js";

export const ORDER_STATUSES = ["pending_payment", "confirmed", "completed", "cancelled", "expired"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const SUB_ORDER_STATUSES = ["awaiting_payment", "placed", "packed", "shipped", "delivered", "cancelled"] as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUSES)[number];
export const PAYMENT_STATUSES = ["created", "paid", "failed", "refunded", "partially_refunded"] as const;
export const PAYOUT_STATUSES = ["held", "released", "paid", "reversed", "failed"] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const REFUND_STATUSES = ["pending", "processed", "failed"] as const;
export const ACTOR_ROLES = ["customer", "vendor", "admin", "system"] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

// A copy of the delivery address taken at checkout (stored as JSON on the order).
export interface ShippingAddress {
  name: string;
  phone: string;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  pincode: string;
}

// Rows with the children every view needs. Queries use these includes so the shapes always match.
export const orderInclude = { lines: { orderBy: { position: "asc" } } } satisfies Prisma.OrderInclude;
export const subOrderInclude = {
  lines: { orderBy: { position: "asc" } },
  history: { orderBy: [{ at: "asc" }, { id: "asc" }] },
} satisfies Prisma.SubOrderInclude;
export type OrderRow = Order & { lines: OrderLine[] };
export type SubOrderRow = SubOrder & { lines: OrderLine[]; history: SubOrderEvent[] };
export type { Order, OrderLine, SubOrder };

export const shippingAddressOf = (o: Pick<Order, "shippingAddress">) => o.shippingAddress as unknown as ShippingAddress;

export const formatOrderNumber = (year: number, seq: number) => `SS-${year}-${String(seq).padStart(6, "0")}`;

export async function nextOrderNumber(now = new Date(), tx?: Tx): Promise<string> {
  const year = now.getUTCFullYear();
  return formatOrderNumber(year, await nextSeq(`order-${year}`, tx));
}
