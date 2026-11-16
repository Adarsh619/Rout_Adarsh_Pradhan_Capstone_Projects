import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/db.js";
import type { Storage } from "../../lib/s3.js";
import { pageQuery } from "../../middleware/validate.js";
import { toProductCard, withImages } from "./product.model.js";

// Browsing lists straight from the database (home page, category and store pages); full-text search and filters go
// through Elasticsearch. Shoppers only ever see active products of approved stores.
export const SORTS = {
  newest: [{ createdAt: "desc" }, { id: "asc" }],
  price_asc: [{ price: "asc" }, { id: "asc" }],
  price_desc: [{ price: "desc" }, { id: "asc" }],
  rating: [{ ratingAvg: "desc" }, { ratingCount: "desc" }, { id: "asc" }],
} as const satisfies Record<string, Prisma.ProductOrderByWithRelationInput[]>;

export const storefrontQuery = pageQuery.extend({
  category: z.string().max(80).optional(),
  sort: z.enum(Object.keys(SORTS) as [keyof typeof SORTS, ...(keyof typeof SORTS)[]]).default("newest"),
});

export async function listStorefront(
  opts: { vendorId?: string; categorySlug?: string; sort: keyof typeof SORTS; page: number; limit: number },
  storage: Storage,
) {
  let categoryIds: string[] | undefined;
  if (opts.categorySlug) {
    const category = await prisma.category.findFirst({
      where: { slug: opts.categorySlug, isActive: true },
      include: { children: { where: { isActive: true }, select: { id: true } } },
    });
    if (!category) return { items: [], page: opts.page, limit: opts.limit, total: 0 };
    // A department includes all of its sub-categories.
    categoryIds = [category.id, ...category.children.map((c) => c.id)];
  }

  const where: Prisma.ProductWhereInput = {
    status: "active",
    vendor: { status: "approved", ...(opts.vendorId && { id: opts.vendorId }) },
    ...(categoryIds && { categoryId: { in: categoryIds } }),
  };
  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: [...SORTS[opts.sort]],
      skip: (opts.page - 1) * opts.limit,
      take: opts.limit,
      include: { ...withImages, vendor: { select: { storeName: true, slug: true } } },
    }),
    prisma.product.count({ where }),
  ]);
  return {
    items: products.map((p) => toProductCard(p, p.vendor, storage)),
    page: opts.page,
    limit: opts.limit,
    total,
  };
}
