import type { Types } from "mongoose";
import { z } from "zod";
import type { Storage } from "../../lib/s3.js";
import { pageQuery } from "../../middleware/validate.js";
import { Vendor } from "../vendors/vendor.model.js";
import { Category } from "./category.model.js";
import { Product, toProductCard } from "./product.model.js";

// Browsing lists straight from MongoDB (home page, category and store pages). Full-text search and
// filters arrive with Elasticsearch on Day 4. Shoppers only ever see active products of approved stores.
export const SORTS = {
  newest: { createdAt: -1 },
  price_asc: { price: 1, _id: 1 },
  price_desc: { price: -1, _id: 1 },
  rating: { ratingAvg: -1, ratingCount: -1, _id: 1 },
} as const;

export const storefrontQuery = pageQuery.extend({
  category: z.string().max(80).optional(),
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default("newest"),
});

export async function listStorefront(
  opts: { vendorId?: Types.ObjectId | string; categorySlug?: string; sort: keyof typeof SORTS; page: number; limit: number },
  storage: Storage,
) {
  const vendors = await Vendor.find({ status: "approved", ...(opts.vendorId && { _id: opts.vendorId }) }).select("storeName slug");
  const byId = new Map(vendors.map((v) => [v.id as string, v]));

  let categoryIds: Types.ObjectId[] | undefined;
  if (opts.categorySlug) {
    const category = await Category.findOne({ slug: opts.categorySlug, isActive: true });
    if (!category) return { items: [], page: opts.page, limit: opts.limit, total: 0 };
    // A department includes all of its sub-categories.
    const children = await Category.find({ parentId: category._id, isActive: true }).select("_id");
    categoryIds = [category._id, ...children.map((c) => c._id)];
  }

  const filter = {
    status: "active" as const,
    vendorId: { $in: vendors.map((v) => v._id) },
    ...(categoryIds && { categoryId: { $in: categoryIds } }),
  };
  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort(SORTS[opts.sort])
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit),
    Product.countDocuments(filter),
  ]);
  return {
    items: products.map((p) => toProductCard(p, byId.get(p.vendorId.toString())!, storage)),
    page: opts.page,
    limit: opts.limit,
    total,
  };
}
