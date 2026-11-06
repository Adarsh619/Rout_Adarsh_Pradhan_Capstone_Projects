import { randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

// The cart lives in Redis, not MongoDB: it changes often, needs no history, and expires by itself.
// One hash per cart: field = product id, value = {"qty":2,"at":<added, ms>}.
export const CART_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_CART_LINES = 50;
export const MAX_LINE_QTY = 10;

export const GUEST_COOKIE = "ss_guest";
const GUEST_ID = /^[A-Za-z0-9_-]{22}$/;

export const userCartKey = (userId: string) => `cart:${userId}`;
export const guestCartKey = (guestId: string) => `cart:guest:${guestId}`;
export const newGuestId = () => randomBytes(16).toString("base64url");
export const isGuestId = (value: unknown): value is string => typeof value === "string" && GUEST_ID.test(value);

export interface CartLine {
  productId: string;
  qty: number;
  addedAt: number;
}

function parseLine(productId: string, raw: string): CartLine | undefined {
  try {
    const v = JSON.parse(raw) as { qty?: unknown; at?: unknown };
    const qty = Number(v.qty);
    if (!Number.isInteger(qty) || qty < 1) return undefined;
    return { productId, qty: Math.min(qty, MAX_LINE_QTY), addedAt: Number(v.at) || 0 };
  } catch {
    return undefined;
  }
}

const encode = (qty: number, addedAt: number) => JSON.stringify({ qty, at: addedAt });

export class CartStore {
  constructor(readonly redis: Redis) {}

  // Newest first. Reading also pushes the expiry back, so an active cart never disappears.
  async read(key: string): Promise<CartLine[]> {
    const [hash] = await Promise.all([this.redis.hgetall(key), this.redis.expire(key, CART_TTL_SECONDS)]);
    return Object.entries(hash)
      .map(([id, raw]) => parseLine(id, raw))
      .filter((l): l is CartLine => l !== undefined)
      .sort((a, b) => b.addedAt - a.addedAt);
  }

  async setQty(key: string, productId: string, qty: number, addedAt = Date.now()): Promise<void> {
    await this.redis.multi().hset(key, productId, encode(qty, addedAt)).expire(key, CART_TTL_SECONDS).exec();
  }

  async remove(key: string, ...productIds: string[]): Promise<void> {
    if (productIds.length) await this.redis.hdel(key, ...productIds);
  }

  async clear(key: string): Promise<void> {
    await this.redis.del(key);
  }

  // Signing in moves the guest's cart into the account: quantities of the same product add up (up to the
  // per-line limit), new products are added while there is room, and the guest cart is deleted.
  async merge(fromKey: string, toKey: string): Promise<number> {
    const [guest, mine] = await Promise.all([this.read(fromKey), this.read(toKey)]);
    if (guest.length === 0) return 0;
    const existing = new Map(mine.map((l) => [l.productId, l]));
    const tx = this.redis.multi();
    let lines = mine.length;
    let moved = 0;
    for (const line of guest) {
      const current = existing.get(line.productId);
      if (current) {
        tx.hset(toKey, line.productId, encode(Math.min(MAX_LINE_QTY, current.qty + line.qty), current.addedAt));
      } else if (lines < MAX_CART_LINES) {
        tx.hset(toKey, line.productId, encode(line.qty, line.addedAt));
        lines++;
      } else continue;
      moved++;
    }
    await tx.expire(toKey, CART_TTL_SECONDS).del(fromKey).exec();
    return moved;
  }
}
