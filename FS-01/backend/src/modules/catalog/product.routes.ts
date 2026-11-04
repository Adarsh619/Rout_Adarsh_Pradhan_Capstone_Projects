import { Router } from "express";
import { z } from "zod";
import { cached, cacheKeys, invalidate } from "../../lib/cache.js";
import { uniqueSlug } from "../../lib/slug.js";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, objectId, pageQuery, parseQuery, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { checkUploadedImage, UPLOAD_PURPOSES } from "../uploads/upload-rules.js";
import { loadOwnStore } from "../vendors/vendor-access.js";
import { Vendor, type VendorDoc } from "../vendors/vendor.model.js";
import { Category } from "./category.model.js";
import { MAX_IMAGES, Product, PRODUCT_STATUSES, toPublicProduct, toVendorProduct, type ProductDoc } from "./product.model.js";
import { listStorefront, storefrontQuery } from "./storefront.js";

// Prices are integer paise. ₹1 to ₹1 crore covers everything from a pencil to a car.
const paise = z.number({ error: "Enter an amount" }).int("Amounts are in paise (whole numbers)").min(100, "Minimum price is ₹1").max(1_000_000_000, "Maximum price is ₹1 crore");
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || undefined);

const productFields = {
  title: z.string().trim().min(3, "Title needs at least 3 characters").max(150),
  description: z.string().trim().max(5000).default(""),
  brand: optionalText(60).optional(),
  categoryId: objectId,
  price: paise,
  // The "was" price shown crossed out. Defaults to the price (no discount).
  mrp: paise.optional(),
  stock: z.number({ error: "Enter the stock" }).int().min(0, "Stock can't be negative").max(100_000),
  sku: optionalText(40)
    .refine((s) => s === undefined || /^[A-Za-z0-9._-]+$/.test(s), "Letters, numbers, dots, dashes and underscores only")
    .optional(),
  attributes: z
    .record(z.string().trim().min(1).max(40), z.string().trim().min(1).max(200))
    .refine((a) => Object.keys(a).length <= 20, "Up to 20 specifications")
    .default({}),
  images: z
    .array(z.object({ key: z.string().min(1).max(300), alt: z.string().trim().max(150).default("") }))
    .max(MAX_IMAGES, `Up to ${MAX_IMAGES} photos`)
    .refine((imgs) => new Set(imgs.map((i) => i.key)).size === imgs.length, "The same photo is added twice")
    .default([]),
  status: z.enum(PRODUCT_STATUSES).default("draft"),
};
const createSchema = z.object(productFields);
const updateSchema = z.object(productFields).partial();
type ProductInput = z.infer<typeof createSchema>;

const vendorListQuery = pageQuery.extend({
  status: z.enum(PRODUCT_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
});

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function productRouter(ctx: RouteContext): Router {
  const router = Router();
  const sellerOnly = [ctx.signedIn, requireRole("vendor"), loadOwnStore({ approved: true })];

  // Rules that need more than one field or the database. Collects every problem so the form can show them together.
  async function checkProduct(input: ProductInput & { mrp: number }, vendor: VendorDoc, existingKeys: string[]) {
    const fields: { field: string; message: string }[] = [];
    if (input.mrp < input.price) fields.push({ field: "mrp", message: "MRP can't be lower than the selling price" });
    if (input.status === "active" && input.images.length === 0) {
      fields.push({ field: "images", message: "Add at least one photo before publishing" });
    }
    const category = await Category.findById(input.categoryId);
    if (!category || !category.isActive) fields.push({ field: "categoryId", message: "Choose a category from the list" });

    const prefix = UPLOAD_PURPOSES["product-image"](vendor.id as string);
    const newImages = input.images.map((img, i) => ({ ...img, i })).filter((img) => !existingKeys.includes(img.key));
    const problems = await Promise.all(newImages.map((img) => checkUploadedImage(ctx.storage, img.key, prefix)));
    problems.forEach((message, n) => {
      if (message) fields.push({ field: `images.${newImages[n]!.i}`, message });
    });
    if (fields.length) throw new AppError(400, "validation_error", "Some fields need fixing", { fields });
  }

  const skuTaken = (err: unknown) => {
    if (typeof err === "object" && err !== null && "code" in err && err.code === 11000 && "keyPattern" in err) {
      const pattern = err.keyPattern as Record<string, unknown>;
      if ("sku" in pattern) {
        throw new AppError(409, "sku_taken", "You already have a product with this SKU", {
          fields: [{ field: "sku", message: "You already have a product with this SKU" }],
        });
      }
    }
    throw err;
  };

  // Only the owner's products are ever found, so another vendor's product id answers 404 (not 403),
  // which also doesn't reveal that it exists.
  const findOwn = async (id: string, vendor: VendorDoc): Promise<ProductDoc> => {
    const product = await Product.findOne({ _id: id, vendorId: vendor._id });
    if (!product) throw new AppError(404, "not_found", "Product not found");
    return product;
  };

  // ---- Shoppers --------------------------------------------------------------------------------

  router.get("/products", async (req, res) => {
    const q = parseQuery(storefrontQuery, req);
    res.json(await listStorefront({ categorySlug: q.category, sort: q.sort, page: q.page, limit: q.limit }, ctx.storage));
  });

  router.get("/products/:id", async (req, res) => {
    const id = idParam(req);
    const { value, hit } = await cached(ctx.redis, cacheKeys.product(id), async () => {
      const product = await Product.findOne({ _id: id, status: "active" });
      if (!product) return null;
      const [vendor, category] = await Promise.all([
        Vendor.findOne({ _id: product.vendorId, status: "approved" }),
        Category.findById(product.categoryId),
      ]);
      return vendor ? toPublicProduct(product, vendor, category, ctx.storage) : null;
    });
    if (!value) throw new AppError(404, "not_found", "Product not found");
    res.set("X-Cache", hit ? "HIT" : "MISS").json({ product: value });
  });

  // ---- The vendor's own products ---------------------------------------------------------------

  router.get("/vendor/products", ...sellerOnly, async (req, res) => {
    const q = parseQuery(vendorListQuery, req);
    const vendorId = req.vendor!._id;
    const filter = {
      vendorId,
      ...(q.status && { status: q.status }),
      ...(q.q && { title: { $regex: escapeRegex(q.q), $options: "i" } }),
    };
    const [products, total, counts] = await Promise.all([
      Product.find(filter)
        .sort({ updatedAt: -1, _id: 1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Product.countDocuments(filter),
      Product.aggregate<{ _id: string; n: number }>([{ $match: { vendorId } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);
    res.json({
      items: products.map((p) => toVendorProduct(p, ctx.storage)),
      page: q.page,
      limit: q.limit,
      total,
      counts: Object.fromEntries(PRODUCT_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
    });
  });

  router.get("/vendor/products/:id", ...sellerOnly, async (req, res) => {
    res.json({ product: toVendorProduct(await findOwn(idParam(req), req.vendor!), ctx.storage) });
  });

  router.post("/vendor/products", ...sellerOnly, validateBody(createSchema), async (req, res) => {
    const vendor = req.vendor!;
    const body = req.body as ProductInput;
    const input = { ...body, mrp: body.mrp ?? body.price };
    await checkProduct(input, vendor, []);
    const slug = await uniqueSlug(input.title, async (s) => (await Product.exists({ vendorId: vendor._id, slug: s })) !== null);
    const product = await Product.create({ ...input, vendorId: vendor._id, slug }).catch(skuTaken);
    res.status(201).json({ product: toVendorProduct(product, ctx.storage) });
  });

  router.patch("/vendor/products/:id", ...sellerOnly, validateBody(updateSchema), async (req, res) => {
    const vendor = req.vendor!;
    const product = await findOwn(idParam(req), vendor);
    const changes = req.body as Partial<ProductInput>;
    const before = toVendorProduct(product, ctx.storage);
    const merged = {
      ...before,
      brand: before.brand ?? undefined,
      sku: before.sku ?? undefined,
      ...changes,
    } as ProductInput;
    // Lowering the price below the old MRP without sending a new MRP keeps the MRP; raising it above moves the MRP up.
    const mrp = changes.mrp ?? Math.max(before.mrp, merged.price);
    const oldKeys = product.images.map((img) => img.key);
    await checkProduct({ ...merged, mrp }, vendor, oldKeys);

    product.set({ ...changes, mrp });
    if ("brand" in changes && !changes.brand) product.brand = undefined;
    if ("sku" in changes && !changes.sku) product.sku = undefined;
    await product.save().catch(skuTaken);

    const removed = oldKeys.filter((k) => !product.images.some((img) => img.key === k));
    void ctx.storage.deleteMany(removed);
    await invalidate(ctx.redis, cacheKeys.product(product.id as string));
    res.json({ product: toVendorProduct(product, ctx.storage) });
  });

  router.delete("/vendor/products/:id", ...sellerOnly, async (req, res) => {
    const product = await findOwn(idParam(req), req.vendor!);
    // Orders keep a snapshot, but invoices, reviews and analytics still point at the product.
    if (product.soldCount > 0) {
      throw new AppError(409, "product_has_orders", "This product has been ordered, so it can't be deleted. Set it to inactive instead.");
    }
    await product.deleteOne();
    void ctx.storage.deleteMany(product.images.map((img) => img.key));
    await invalidate(ctx.redis, cacheKeys.product(product.id as string));
    res.status(204).end();
  });

  return router;
}
