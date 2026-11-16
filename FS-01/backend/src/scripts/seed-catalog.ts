import { readFile } from "node:fs/promises";
import { loadEnv } from "../config/env.js";
import { cacheKeys, invalidate, invalidatePrefix } from "../lib/cache.js";
import { createElasticsearch } from "../lib/elasticsearch.js";
import { logger } from "../lib/logger.js";
import type { Prisma } from "../generated/prisma/client.js";
import { connectDb, disconnectDb, isUniqueViolation, prisma } from "../lib/db.js";
import { createRedis } from "../lib/redis.js";
import { createS3, createStorage, ensureBucket, type Storage } from "../lib/s3.js";
import { slugify } from "../lib/slug.js";
import { hashPassword } from "../modules/auth/password.js";
import { imageRows } from "../modules/catalog/product.model.js";
import { refreshVendorRating, roundRating } from "../modules/reviews/ratings.js";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, UPLOAD_PURPOSES } from "../modules/uploads/upload-rules.js";
import { SearchIndexer } from "../modules/search/search-indexer.js";
import { CATALOG_SNAPSHOT, CATEGORY_TREE, SEED_STORES, seedPrices, type SnapshotProduct } from "./catalog-data.js";

// Fills the marketplace with the demo catalogue: the category tree, five approved stores (plus one application
// waiting for the admin), 214 products whose photos are copied into our own S3 bucket, the products' reviews from the
// source catalogue, three demo coupons, then rebuilds the search index. Safe to run again:
// everything is matched on a fixed key (category slug, owner email, product SKU) and updated in place, and photos
// already in the bucket aren't downloaded twice.
//   npm run seed:catalog                                   (local)
//   docker compose exec api node dist/scripts/seed-catalog.js
//   add --no-images to skip the photo download (new products are then drafts; existing ones keep their photos)

const IMAGE_CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

async function seedCategories(): Promise<Map<string, string>> {
  const bySourceCategory = new Map<string, string>();
  for (const [i, dept] of CATEGORY_TREE.entries()) {
    const fields = { name: dept.name, parentId: null, isActive: true, sortOrder: i };
    const parent = await prisma.category.upsert({ where: { slug: slugify(dept.name) }, update: fields, create: { ...fields, slug: slugify(dept.name) } });
    for (const [j, child] of dept.children.entries()) {
      const childFields = { name: child.name, parentId: parent.id, isActive: true, sortOrder: j };
      const sub = await prisma.category.upsert({
        where: { slug: slugify(child.name) },
        update: childFields,
        create: { ...childFields, slug: slugify(child.name) },
      });
      for (const source of child.from) bySourceCategory.set(source, sub.id);
    }
  }
  return bySourceCategory;
}

async function seedStores(password: string, bcryptCost: number) {
  const passwordHash = await hashPassword(password, bcryptCost);
  const admin = await prisma.user.findUnique({ where: { email: "admin@shopsphere.test" } });
  const vendorBySourceCategory = new Map<string, { id: string; key: string }>();

  for (const store of SEED_STORES) {
    const user = await prisma.user.upsert({
      where: { email: store.owner.email },
      update: { role: "vendor", status: "active", passwordHash },
      create: { email: store.owner.email, name: store.owner.name, role: "vendor", passwordHash },
    });
    const approved = store.status === "approved";
    const fields = {
      storeName: store.storeName,
      slug: slugify(store.storeName),
      description: store.description,
      contactEmail: store.owner.email,
      phone: store.phone,
      ...(store.gstin && { gstin: store.gstin }),
      status: store.status,
      rejectionReason: null,
      approvedAt: approved ? new Date() : null,
      approvedBy: approved ? (admin?.id ?? null) : null,
    };
    const vendor = await prisma.vendor.upsert({ where: { userId: user.id }, update: fields, create: { ...fields, userId: user.id } });
    for (const source of store.sells) vendorBySourceCategory.set(source, { id: vendor.id, key: vendor.id });
    logger.info({ store: store.storeName, owner: store.owner.email, status: store.status }, "store ready");
  }
  return vendorBySourceCategory;
}

const extensionOf = (url: string) => (/\.(png|jpe?g|webp)(\?|$)/i.exec(url)?.[1] ?? "jpg").toLowerCase().replace("jpeg", "jpg");

// Copies one source photo into the bucket under the store's own prefix; returns its key, or null if it failed.
async function copyImage(storage: Storage, url: string, key: string): Promise<string | null> {
  if (await storage.head(key)) return key;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!(contentType in IMAGE_TYPES)) throw new Error(`unexpected type ${contentType}`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > MAX_IMAGE_BYTES) throw new Error("larger than 5 MB");
    await storage.put(key, body, contentType);
    return key;
  } catch (err) {
    logger.warn({ url, err: (err as Error).message }, "photo skipped");
    return null;
  }
}

const skuOf = (p: SnapshotProduct) => `${p.source === "dummyjson" ? "DJ" : "FS"}-${p.sourceId}`;

// The reviews that came with the source catalogue (DummyJSON), marked as seeded (no account behind them, so they
// never count as "verified purchase"). Customers' own reviews are never touched. Then every product's and store's
// rating is recomputed from the visible reviews, the same way the app does it.
async function seedReviews(products: SnapshotProduct[]): Promise<number> {
  let n = 0;
  for (const p of products) {
    const product = await prisma.product.findFirst({ where: { sku: skuOf(p) }, select: { id: true, vendorId: true } });
    if (!product) continue;
    await prisma.review.deleteMany({ where: { productId: product.id, source: "seed" } });
    if (!p.reviews?.length) continue;
    // Each review keeps its original date.
    await prisma.review.createMany({
      data: p.reviews.map((r) => ({
        productId: product.id,
        vendorId: product.vendorId,
        authorName: r.reviewerName.slice(0, 80),
        rating: Math.min(5, Math.max(1, Math.round(r.rating))),
        body: r.comment.slice(0, 2000),
        status: "visible" as const,
        source: "seed" as const,
        createdAt: new Date(r.date),
        updatedAt: new Date(r.date),
      })),
    });
    n += p.reviews.length;
  }
  const averages = await prisma.review.groupBy({ by: ["productId"], where: { status: "visible" }, _avg: { rating: true }, _count: { _all: true } });
  await prisma.product.updateMany({ data: { ratingAvg: 0, ratingCount: 0 } });
  for (const a of averages) {
    await prisma.product.update({ where: { id: a.productId }, data: { ratingAvg: roundRating(a._avg.rating ?? 0), ratingCount: a._count._all } });
  }
  for (const v of await prisma.vendor.findMany({ select: { id: true } })) await refreshVendorRating(v.id);
  return n;
}

// Demo coupons. Matched on the code; how often each has been used is never reset.
async function seedCoupons(): Promise<number> {
  const vikram = await prisma.vendor.findFirst({ where: { owner: { email: "vendor@shopsphere.test" } } });
  const coupons: Prisma.CouponUncheckedCreateInput[] = [
    { code: "WELCOME10", scope: "platform", type: "percent", value: 1000, maxDiscount: 20_000, minOrder: 49_900, perUserLimit: 1, description: "10% off your order, up to ₹200 (orders over ₹499)" },
    { code: "FLAT100", scope: "platform", type: "flat", value: 10_000, minOrder: 100_000, perUserLimit: 3, usageLimit: 1000, description: "₹100 off orders of ₹1,000 or more" },
    ...(vikram
      ? [{ code: "VIKRAM5", scope: "vendor" as const, vendorId: vikram.id, type: "percent" as const, value: 500, minOrder: 100_000, perUserLimit: 2, description: "5% off Vikram Electronics (₹1,000 or more from the store)" }]
      : []),
  ];
  for (const c of coupons) {
    await prisma.coupon.upsert({ where: { code: c.code }, update: { ...c, isActive: true }, create: { ...c, isActive: true } });
  }
  return coupons.length;
}

async function main() {
  const env = loadEnv();
  const withImages = !process.argv.includes("--no-images");
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("Set DEMO_PASSWORD (10+ characters, letters and numbers) before seeding demo stores");
  }

  await connectDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const s3 = createS3(env);
  if (env.S3_CREATE_BUCKET) await ensureBucket(s3, env.S3_BUCKET);
  const storage = createStorage(env, s3);

  const snapshot = JSON.parse(await readFile(CATALOG_SNAPSHOT, "utf8")) as { products: SnapshotProduct[] };
  const categories = await seedCategories();
  const vendors = await seedStores(password, env.BCRYPT_COST);

  const usedSlugs = new Set<string>();
  let saved = 0;
  let photos = 0;
  const started = Date.now();
  await mapLimit(snapshot.products, 4, async (p) => {
    const category = categories.get(p.sourceCategory);
    const vendor = vendors.get(p.sourceCategory);
    if (!category || !vendor) {
      logger.warn({ category: p.sourceCategory }, "no store sells this category; product skipped");
      return;
    }
    const sku = skuOf(p);
    let slug = slugify(p.title);
    if (usedSlugs.has(`${vendor.key}/${slug}`)) slug = `${slug}-${p.sourceId}`;
    usedSlugs.add(`${vendor.key}/${slug}`);

    const prefix = UPLOAD_PURPOSES["product-image"](vendor.key);
    const keys = withImages
      ? (
          await mapLimit(p.images, IMAGE_CONCURRENCY, (url, i) =>
            copyImage(storage, url, `${prefix}seed-${sku.toLowerCase()}-${i + 1}.${extensionOf(url)}`),
          )
        ).filter((k): k is string => k !== null)
      : [];
    photos += keys.length;

    const images = keys.map((key) => ({ key, alt: p.title.slice(0, 150) }));
    const save = (productSlug: string) => {
      const fields = {
        categoryId: category,
        title: p.title.slice(0, 150),
        slug: productSlug,
        description: p.description.slice(0, 5000),
        ...seedPrices(p),
        stock: p.stock,
        attributes: p.attributes,
        brand: p.brand ? p.brand.slice(0, 60) : null,
      };
      // A product needs a photo to be on sale, the same rule vendors follow. Without photos (--no-images) a new
      // product starts as a draft and an existing one keeps its photos and status.
      return prisma.product.upsert({
        where: { vendorId_sku: { vendorId: vendor.id, sku } },
        update: { ...fields, ...(withImages && { status: keys.length ? "active" : "draft", images: { deleteMany: {}, create: imageRows(images) } }) },
        create: { ...fields, vendorId: vendor.id, sku, status: withImages && keys.length ? "active" : "draft", images: { create: imageRows(images) } },
      });
    };
    // A vendor may already have their own product with this URL slug; then the seeded one gets a suffix.
    await save(slug).catch((err: unknown) => {
      if (isUniqueViolation(err)) return save(`${slug}-${sku.toLowerCase()}`);
      throw err;
    });
    saved++;
  });

  const reviews = await seedReviews(snapshot.products);
  const coupons = await seedCoupons();

  await Promise.all([invalidate(redis, cacheKeys.categories), invalidatePrefix(redis, cacheKeys.product(""))]);
  // Rebuild search from what was just saved, so it matches the catalogue exactly.
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const { indexed } = await new SearchIndexer(es, env.ES_INDEX).reindexAll();
  logger.info({ products: saved, photos, reviews, coupons, searchable: indexed, seconds: Math.round((Date.now() - started) / 1000) }, "demo catalogue ready");
  await Promise.allSettled([disconnectDb(), redis.quit(), es.close()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seeding the catalogue failed");
  process.exit(1);
});
