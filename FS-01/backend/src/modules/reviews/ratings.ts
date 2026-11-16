import type { Redis } from "ioredis";
import type { Prisma } from "../../generated/prisma/client.js";
import { cacheKeys, invalidate } from "../../lib/cache.js";
import { prisma } from "../../lib/db.js";
import type { SearchSync } from "../search/search-sync.js";

// Ratings shown on products and stores are always computed from the visible reviews, never typed in, so hiding a
// review or adding one changes them at once. Rounded to one decimal, like the stars on the page.
export const roundRating = (avg: number) => Math.round(avg * 10) / 10;

async function averageOf(where: Prisma.ReviewWhereInput) {
  const r = await prisma.review.aggregate({ where: { ...where, status: "visible" }, _avg: { rating: true }, _count: { _all: true } });
  return { ratingAvg: r._avg.rating === null ? 0 : roundRating(r._avg.rating), ratingCount: r._count._all };
}

export async function refreshVendorRating(vendorId: string): Promise<void> {
  await prisma.vendor.update({ where: { id: vendorId }, data: await averageOf({ vendorId }) });
}

export async function refreshRatings(
  deps: { redis: Redis; searchSync: SearchSync },
  productId: string,
  vendorId: string,
): Promise<{ ratingAvg: number; ratingCount: number }> {
  const rating = await averageOf({ productId });
  await prisma.product.update({ where: { id: productId }, data: rating });
  await refreshVendorRating(vendorId);
  await invalidate(deps.redis, cacheKeys.product(productId));
  // Search sorts and filters by rating.
  await deps.searchSync.product(productId);
  return rating;
}
