import { isBuyable } from "../cart/cart-view.js";
import type { CartLine } from "../cart/cart-store.js";
import { Category } from "../catalog/category.model.js";
import { Product } from "../catalog/product.model.js";
import { Vendor, type VendorDoc } from "../vendors/vendor.model.js";
import { commissionRate, type PricedLine } from "./order-rules.js";

export interface LineProblemInfo {
  productId: string;
  title?: string;
  problem: "unavailable" | "out_of_stock";
  available?: number;
}

// Prices cart lines with today's prices, stock and commission rates. Used by checkout and by the cart's coupon
// preview, so the discount a shopper sees is the one checkout charges.
export async function priceLines(lines: CartLine[]): Promise<{ priced: PricedLine[]; problems: LineProblemInfo[]; vendorById: Map<string, VendorDoc> }> {
  const products = await Product.find({ _id: { $in: lines.map((l) => l.productId) } });
  const productById = new Map(products.map((p) => [p.id as string, p]));
  const vendors = await Vendor.find({ _id: { $in: products.map((p) => p.vendorId) } });
  const vendorById = new Map(vendors.map((v) => [v.id as string, v]));
  const categories = await Category.find({ _id: { $in: products.map((p) => p.categoryId) } });
  const parents = await Category.find({ _id: { $in: categories.map((c) => c.parentId).filter(Boolean) } });
  const categoryById = new Map([...categories, ...parents].map((c) => [c.id as string, c]));

  const problems: LineProblemInfo[] = [];
  const priced: PricedLine[] = [];
  for (const line of lines) {
    const p = productById.get(line.productId);
    const vendor = p && vendorById.get(p.vendorId.toString());
    if (!p || !isBuyable(p, vendor)) {
      problems.push({ productId: line.productId, title: p?.title, problem: "unavailable" });
      continue;
    }
    if (line.qty > p.stock) {
      problems.push({ productId: line.productId, title: p.title, problem: "out_of_stock", available: p.stock });
      continue;
    }
    const category = categoryById.get(p.categoryId.toString());
    const department = category?.parentId ? categoryById.get(category.parentId.toString()) : undefined;
    priced.push({
      productId: line.productId,
      vendorId: p.vendorId.toString(),
      title: p.title,
      ...(p.images[0] && { imageKey: p.images[0].key }),
      price: p.price,
      qty: line.qty,
      commissionRateBp: commissionRate(vendor!.commissionRateBp, category?.commissionRateBp, department?.commissionRateBp),
    });
  }
  return { priced, problems, vendorById };
}
