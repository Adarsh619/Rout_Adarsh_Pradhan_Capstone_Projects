import { Router, type CookieOptions, type Request, type Response } from "express";
import { z } from "zod";
import { requireCsrfHeader } from "../../middleware/csrf.js";
import { AppError } from "../../middleware/errors.js";
import { objectId, validateBody } from "../../middleware/validate.js";
import { Product } from "../catalog/product.model.js";
import type { RouteContext } from "../context.js";
import { Vendor } from "../vendors/vendor.model.js";
import {
  CART_TTL_SECONDS,
  CartStore,
  GUEST_COOKIE,
  guestCartKey,
  isGuestId,
  MAX_CART_LINES,
  MAX_LINE_QTY,
  newGuestId,
  userCartKey,
} from "./cart-store.js";
import { buildCartView, emptyCart, isBuyable } from "./cart-view.js";

const qty = z
  .number({ error: "Enter a quantity" })
  .int()
  .min(1, "At least 1")
  .max(MAX_LINE_QTY, `Up to ${MAX_LINE_QTY} of each product`);
const addSchema = z.object({ productId: objectId, qty: qty.default(1) });
const updateSchema = z.object({ qty });

export type CookieSettings = { secure: boolean; sameSite: "lax" | "strict" | "none" };

// The guest cookie is sent to every /api/v1 route (the cart, and sign-in so the cart can be merged).
export const guestCookieOptions = (cookies: CookieSettings): CookieOptions => ({
  httpOnly: true,
  secure: cookies.secure,
  sameSite: cookies.sameSite,
  path: "/api/v1",
  maxAge: CART_TTL_SECONDS * 1000,
});

// Moves a guest's cart into the account they just signed in to, then forgets the guest id.
export function mergeGuestCartOnSignIn(store: CartStore, cookies: CookieSettings) {
  return async (req: Request, res: Response, userId: string) => {
    const guestId: unknown = req.cookies?.[GUEST_COOKIE];
    if (!isGuestId(guestId)) return;
    await store.merge(guestCartKey(guestId), userCartKey(userId));
    // clearCookie needs the same attributes the cookie was set with, minus maxAge.
    const opts = guestCookieOptions(cookies);
    delete opts.maxAge;
    res.clearCookie(GUEST_COOKIE, opts);
  };
}

// Everyone has a cart: a signed-in user's is tied to the account, a guest's to an httpOnly cookie.
export function cartRouter(ctx: RouteContext): Router {
  const router = Router();
  const store = new CartStore(ctx.redis);
  // Writes act on a cookie for guests, so they need the CSRF header like the other cookie endpoints.
  const write = [ctx.maybeSignedIn, requireCsrfHeader];

  // The Redis key for this request's cart; with create, a guest without a cookie gets a new one.
  function cartKey(req: Request, res: Response, create: boolean): string | undefined {
    if (req.auth) return userCartKey(req.auth.id);
    const existing: unknown = req.cookies?.[GUEST_COOKIE];
    if (isGuestId(existing)) return guestCartKey(existing);
    if (!create) return undefined;
    const id = newGuestId();
    res.cookie(GUEST_COOKIE, id, guestCookieOptions(ctx.cookies));
    return guestCartKey(id);
  }

  async function view(key: string | undefined) {
    if (!key) return emptyCart();
    const { cart, gone } = await buildCartView(await store.read(key), ctx.storage);
    // A product deleted by its vendor simply disappears from carts.
    await store.remove(key, ...gone);
    return cart;
  }

  async function buyableProduct(productId: string) {
    const product = await Product.findById(productId);
    const vendor = product ? await Vendor.findById(product.vendorId) : null;
    if (!product || !isBuyable(product, vendor)) {
      throw new AppError(404, "not_found", "This product isn't available any more");
    }
    return product;
  }

  const notEnough = (stock: number, inCart = 0) =>
    new AppError(
      409,
      "out_of_stock",
      stock === 0 ? "This product is out of stock" : `Only ${stock} left${inCart ? `, and ${inCart} are already in your cart` : ""}`,
      { available: stock, inCart },
    );

  router.get("/cart", ctx.maybeSignedIn, async (req, res) => {
    res.json({ cart: await view(cartKey(req, res, false)) });
  });

  router.post("/cart/items", ...write, validateBody(addSchema), async (req, res) => {
    const { productId, qty: adding } = req.body as z.infer<typeof addSchema>;
    const product = await buyableProduct(productId);
    const key = cartKey(req, res, true)!;
    const lines = await store.read(key);
    const current = lines.find((l) => l.productId === productId);
    if (!current && lines.length >= MAX_CART_LINES) {
      throw new AppError(409, "cart_full", `Your cart can hold up to ${MAX_CART_LINES} different products`);
    }
    const inCart = current?.qty ?? 0;
    const wanted = Math.min(MAX_LINE_QTY, inCart + adding);
    if (wanted > product.stock) throw notEnough(product.stock, inCart);
    await store.setQty(key, productId, wanted, current?.addedAt);
    res.status(current ? 200 : 201).json({ cart: await view(key) });
  });

  router.patch("/cart/items/:productId", ...write, validateBody(updateSchema), async (req, res) => {
    const productId = objectId.safeParse(req.params.productId);
    const key = cartKey(req, res, false);
    const line = key && productId.success ? (await store.read(key)).find((l) => l.productId === productId.data) : undefined;
    if (!key || !line) throw new AppError(404, "not_found", "That product isn't in your cart");
    const product = await buyableProduct(line.productId);
    const { qty: wanted } = req.body as z.infer<typeof updateSchema>;
    if (wanted > product.stock) throw notEnough(product.stock);
    await store.setQty(key, line.productId, wanted, line.addedAt);
    res.json({ cart: await view(key) });
  });

  router.delete("/cart/items/:productId", ...write, async (req, res) => {
    const key = cartKey(req, res, false);
    if (key) await store.remove(key, String(req.params.productId));
    res.json({ cart: await view(key) });
  });

  return router;
}
