import { Redis } from "ioredis";

// BullMQ needs maxRetriesPerRequest: null on the connections it uses; the same setting is fine for the cache.
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

export async function pingRedis(redis: Redis): Promise<void> {
  const reply = await redis.ping();
  if (reply !== "PONG") throw new Error(`unexpected reply ${reply}`);
}
