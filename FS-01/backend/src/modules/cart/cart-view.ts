import type { Storage } from "../../lib/s3.js";
import { Product, type ProductDoc } from "../catalog/product.model.js";
import { Vendor, type VendorDoc } from "../vendors/vendor.model.js";
import type { CartLine } from "./cart-store.js";

// What can stop a line from being bought right now. The cart keeps such lines (so the shopper sees what changed)
// but checkout is blocked until they're fixed or removed.
export type LineProblem = "unavailable" | "out_of_stock" | "not_enough_stock";

export interface CartItemView {
  productId: string;
  title: string;
  image: { url: string; alt: string } | null;
  price: number;
  mrp: number;
  qty: number;
  stock: number;
  lineTotal: number;
  problem: LineProblem | null;
}

export interface CartView {
  groups: { vendor: { id: string; storeName: string; slug: string }; items: CartItemView[]; subtotal: number }[];
  itemCount: number;
  itemsTotal: number;
  problems: number;
  canCheckout: boolean;
  // The applied coupon (if any) and what it takes off right now; couponProblem says why it doesn't apply.
  coupon: { code: string; description: string | null; scope: "platform" | "vendor"; storeName: string | null } | null;
  couponProblem: string | null;
  discount: number;
  grandTotal: number;
}

export const emptyCart = (): CartView => ({
  groups: [],
  itemCount: 0,
  itemsTotal: 0,
  problems: 0,
  canCheckout: false,
  coupon: null,
  couponProblem: null,
  discount: 0,
  grandTotal: 0,
});

export const isBuyable = (p: ProductDoc, v: VendorDoc | null | undefined) => p.status === "active" && v?.status === "approved";

export function lineProblem(p: ProductDoc, v: VendorDoc | undefined, qty: number): LineProblem | null {
  if (!isBuyable(p, v)) return "unavailable";
  if (p.stock <= 0) return "out_of_stock";
  if (qty > p.stock) return "not_enough_stock";
  return null;
}

// Builds the cart with today's prices and stock, grouped by store (each store becomes one sub-order at checkout).
// Lines whose product was deleted are returned in `gone` so the caller can drop them from Redis.
export async function buildCartView(lines: CartLine[], storage: Storage): Promise<{ cart: CartView; gone: string[] }> {
  if (lines.length === 0) return { cart: emptyCart(), gone: [] };
  const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) } });
  const byId = new Map(products.map((p) => [p.id as string, p]));
  const vendors = await Vendor.find({ _id: { $in: [...new Set(products.map((p) => p.vendorId.toString()))] } });
  const vendorById = new Map(vendors.map((v) => [v.id as string, v]));

  const groups = new Map<string, CartView["groups"][number]>();
  const gone: string[] = [];
  let itemCount = 0;
  let itemsTotal = 0;
  let problems = 0;

  for (const line of lines) {
    const p = byId.get(line.productId);
    if (!p) {
      gone.push(line.productId);
      continue;
    }
    const vendor = vendorById.get(p.vendorId.toString());
    const problem = lineProblem(p, vendor, line.qty);
    const cover = p.images[0];
    const item: CartItemView = {
      productId: line.productId,
      title: p.title,
      image: cover ? { url: storage.publicUrl(cover.key), alt: cover.alt || p.title } : null,
      price: p.price,
      mrp: p.mrp,
      qty: line.qty,
      stock: problem === "unavailable" ? 0 : p.stock,
      lineTotal: p.price * line.qty,
      problem,
    };
    const vendorKey = p.vendorId.toString();
    let group = groups.get(vendorKey);
    if (!group) {
      group = {
        vendor: { id: vendorKey, storeName: vendor?.storeName ?? "Unknown store", slug: vendor?.slug ?? "" },
        items: [],
        subtotal: 0,
      };
      groups.set(vendorKey, group);
    }
    group.items.push(item);
    itemCount += line.qty;
    if (problem) problems++;
    else {
      group.subtotal += item.lineTotal;
      itemsTotal += item.lineTotal;
    }
  }

  return {
    cart: {
      ...emptyCart(),
      groups: [...groups.values()],
      itemCount,
      itemsTotal,
      grandTotal: itemsTotal,
      problems,
      canCheckout: groups.size > 0 && problems === 0,
    },
    gone,
  };
}
