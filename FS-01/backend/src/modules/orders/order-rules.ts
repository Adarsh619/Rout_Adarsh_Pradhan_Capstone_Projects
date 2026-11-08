import type { OrderStatus, SubOrderStatus } from "./order.model.js";

// Pure rules for orders, kept apart from the database so they can be unit-tested on their own.

// 10%: used when neither the vendor nor the product's category (or its department) has its own rate.
export const PLATFORM_COMMISSION_BP = 1000;

export function commissionRate(vendorBp: number | null | undefined, categoryBp: number | null | undefined, departmentBp: number | null | undefined): number {
  return vendorBp ?? categoryBp ?? departmentBp ?? PLATFORM_COMMISSION_BP;
}

// Rounded once, to the nearest paisa, per line.
export const commissionOf = (amountPaise: number, rateBp: number) => Math.round((amountPaise * rateBp) / 10_000);

export interface PricedLine {
  productId: string;
  vendorId: string;
  title: string;
  imageKey?: string;
  price: number;
  qty: number;
  commissionRateBp: number;
}

export interface VendorPart<L extends PricedLine = PricedLine> {
  vendorId: string;
  items: L[];
  itemsTotal: number;
  commission: number;
  vendorNet: number;
}

// One part per store, in the order the stores first appear. Without a coupon the customer pays itemsTotal for each
// part, the platform keeps the commission and the vendor gets the rest.
export function splitByVendor<L extends PricedLine>(lines: L[]): VendorPart<L>[] {
  const parts = new Map<string, VendorPart<L>>();
  for (const line of lines) {
    let part = parts.get(line.vendorId);
    if (!part) {
      part = { vendorId: line.vendorId, items: [], itemsTotal: 0, commission: 0, vendorNet: 0 };
      parts.set(line.vendorId, part);
    }
    const amount = line.price * line.qty;
    part.items.push(line);
    part.itemsTotal += amount;
    part.commission += commissionOf(amount, line.commissionRateBp);
  }
  for (const part of parts.values()) part.vendorNet = part.itemsTotal - part.commission;
  return [...parts.values()];
}

// What a vendor may do next with a paid part. One step at a time, so the customer's timeline has every stage.
export const VENDOR_NEXT: Partial<Record<SubOrderStatus, SubOrderStatus>> = {
  placed: "packed",
  packed: "shipped",
  shipped: "delivered",
};

export const canVendorMove = (from: SubOrderStatus, to: SubOrderStatus) => VENDOR_NEXT[from] === to;

// The customer can cancel a part until it leaves the warehouse.
export const CUSTOMER_CANCELLABLE: readonly SubOrderStatus[] = ["placed", "packed"];
export const canCustomerCancel = (status: SubOrderStatus) => CUSTOMER_CANCELLABLE.includes(status);

// An admin can also cancel and refund a part that's already on its way (e.g. lost in transit), but not one delivered.
export const ADMIN_CANCELLABLE: readonly SubOrderStatus[] = ["placed", "packed", "shipped"];
export const canAdminCancel = (status: SubOrderStatus) => ADMIN_CANCELLABLE.includes(status);

// A paid order is completed once every part is delivered or cancelled (cancelled if none was delivered).
export function rollUpOrderStatus(parts: SubOrderStatus[]): Extract<OrderStatus, "confirmed" | "completed" | "cancelled"> {
  const finished = parts.every((s) => s === "delivered" || s === "cancelled");
  if (!finished) return "confirmed";
  return parts.includes("delivered") ? "completed" : "cancelled";
}
