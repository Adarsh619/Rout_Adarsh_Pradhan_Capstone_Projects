import type { Redis } from "ioredis";

// Fixed-window counter in Redis: `limit` hits per `windowSeconds` for each key (an IP address, an email, ...).
// Shared by every API container, unlike an in-memory counter.
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export async function hit(redis: Redis, key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const k = `rl:${key}`;
  // SET NX starts the window (with its expiry) only on the first hit, in the same transaction as the increment.
  const results = (await redis.multi().set(k, 0, "EX", windowSeconds, "NX").incr(k).ttl(k).exec()) as [
    unknown,
    [null, number],
    [null, number],
  ];
  const count = results[1][1];
  const ttl = results[2][1];
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
}

export async function peek(redis: Redis, key: string, limit: number): Promise<RateLimitResult> {
  const k = `rl:${key}`;
  const [[, count], [, ttl]] = (await redis.multi().get(k).ttl(k).exec()) as [[null, string | null], [null, number]];
  const n = Number(count ?? 0);
  return { allowed: n < limit, remaining: Math.max(0, limit - n), retryAfterSeconds: Math.max(ttl, 0) };
}

export async function reset(redis: Redis, key: string): Promise<void> {
  await redis.del(`rl:${key}`);
}
