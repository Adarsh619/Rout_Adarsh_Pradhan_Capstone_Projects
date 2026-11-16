import { isBuyable } from "../cart/cart-view.js";
import type { CartLine } from "../cart/cart-store.js";
import { prisma } from "../../lib/db.js";
import { isEntityId } from "../../middleware/validate.js";
import { withImages } from "../catalog/product.model.js";
import type { VendorRow } from "../vendors/vendor.model.js";
import { commissionRate, type PricedLine } from "./order-rules.js";

export interface LineProblemInfo {
  productId: string;
  title?: string;
  problem: "unavailable" | "out_of_stock";
  available?: number;
}

// Prices cart lines with today's prices, stock and commission rates. Used by checkout and by the cart's coupon
// preview, so the discount a shopper sees is the one checkout charges.
export async function priceLines(lines: CartLine[]): Promise<{ priced: PricedLine[]; problems: LineProblemInfo[]; vendorById: Map<string, VendorRow> }> {
  const products = await prisma.product.findMany({
    where: { id: { in: lines.map((l) => l.productId).filter(isEntityId) } },
    include: { ...withImages, vendor: true, category: { include: { parent: true } } },
  });
  const productById = new Map(products.map((p) => [p.id, p]));
  const vendorById = new Map(products.map((p) => [p.vendorId, p.vendor]));

  const problems: LineProblemInfo[] = [];
  const priced: PricedLine[] = [];
  for (const line of lines) {
    const p = productById.get(line.productId);
    const vendor = p?.vendor;
    if (!p || !isBuyable(p, vendor)) {
      problems.push({ productId: line.productId, title: p?.title, problem: "unavailable" });
      continue;
    }
    if (line.qty > p.stock) {
      problems.push({ productId: line.productId, title: p.title, problem: "out_of_stock", available: p.stock });
      continue;
    }
    const category = p.category;
    const department = category.parent;
    priced.push({
      productId: line.productId,
      vendorId: p.vendorId,
      title: p.title,
      ...(p.images[0] && { imageKey: p.images[0].key }),
      price: p.price,
      qty: line.qty,
      commissionRateBp: commissionRate(vendor!.commissionRateBp, category.commissionRateBp, department?.commissionRateBp),
    });
  }
  return { priced, problems, vendorById };
}
