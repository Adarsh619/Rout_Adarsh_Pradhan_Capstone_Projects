import type { Redis } from "ioredis";
import { logger } from "./logger.js";

// Read-through JSON cache in Redis. A Redis failure never fails the request: it just falls back to the database.
export const CACHE_TTL_SECONDS = 300;

export const cacheKeys = {
  categories: "cache:categories",
  product: (id: string) => `cache:product:${id}`,
};

export async function cached<T>(redis: Redis, key: string, load: () => Promise<T>, ttl = CACHE_TTL_SECONDS): Promise<{ value: T; hit: boolean }> {
  try {
    const raw = await redis.get(key);
    if (raw !== null) return { value: JSON.parse(raw) as T, hit: true };
  } catch (err) {
    logger.warn({ err, key }, "cache read failed");
  }
  const value = await load();
  // null/undefined (not found) are not cached, so a product created a moment later shows up at once.
  if (value !== null && value !== undefined) {
    redis.set(key, JSON.stringify(value), "EX", ttl).catch((err: unknown) => logger.warn({ err, key }, "cache write failed"));
  }
  return { value, hit: false };
}

export async function invalidate(redis: Redis, ...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    logger.warn({ err, keys }, "cache invalidation failed");
  }
}

// Deletes every key with a prefix (e.g. all cached products after a category is renamed). SCAN, never KEYS.
export async function invalidatePrefix(redis: Redis, prefix: string): Promise<void> {
  try {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", `${prefix}*`, "COUNT", 500);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  } catch (err) {
    logger.warn({ err, prefix }, "cache invalidation failed");
  }
}
