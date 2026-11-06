import type { Redis } from "ioredis";
import { Types } from "mongoose";
import { cacheKeys, invalidate } from "../../lib/cache.js";
import { Product } from "../catalog/product.model.js";
import type { SearchSync } from "../search/search-sync.js";
import { Vendor } from "../vendors/vendor.model.js";
import { Review } from "./review.model.js";

// Ratings shown on products and stores are always computed from the visible reviews, never typed in, so hiding a
// review or adding one changes them at once. Rounded to one decimal, like the stars on the page.
export const roundRating = (avg: number) => Math.round(avg * 10) / 10;

const asId = (id: Types.ObjectId | string) => (typeof id === "string" ? new Types.ObjectId(id) : id);

async function averageOf(match: Record<string, unknown>) {
  const [r] = await Review.aggregate<{ avg: number; n: number }>([{ $match: { ...match, status: "visible" } }, { $group: { _id: null, avg: { $avg: "$rating" }, n: { $sum: 1 } } }]);
  return { ratingAvg: r ? roundRating(r.avg) : 0, ratingCount: r?.n ?? 0 };
}

export async function refreshVendorRating(vendorId: Types.ObjectId | string): Promise<void> {
  await Vendor.updateOne({ _id: vendorId }, { $set: await averageOf({ vendorId: asId(vendorId) }) });
}

export async function refreshRatings(
  deps: { redis: Redis; searchSync: SearchSync },
  productId: Types.ObjectId | string,
  vendorId: Types.ObjectId | string,
): Promise<{ ratingAvg: number; ratingCount: number }> {
  const rating = await averageOf({ productId: asId(productId) });
  await Product.updateOne({ _id: productId }, { $set: rating });
  await refreshVendorRating(vendorId);
  await invalidate(deps.redis, cacheKeys.product(String(productId)));
  // Search sorts and filters by rating.
  await deps.searchSync.product(productId);
  return rating;
}
