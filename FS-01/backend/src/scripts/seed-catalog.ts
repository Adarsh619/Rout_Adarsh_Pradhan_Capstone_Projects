import { readFile } from "node:fs/promises";
import type { Types } from "mongoose";
import { loadEnv } from "../config/env.js";
import { cacheKeys, invalidate, invalidatePrefix } from "../lib/cache.js";
import { createElasticsearch } from "../lib/elasticsearch.js";
import { logger } from "../lib/logger.js";
import { connectMongo, disconnectMongo } from "../lib/mongo.js";
import { createRedis } from "../lib/redis.js";
import { createS3, createStorage, ensureBucket, type Storage } from "../lib/s3.js";
import { slugify } from "../lib/slug.js";
import { hashPassword } from "../modules/auth/password.js";
import { Category } from "../modules/catalog/category.model.js";
import { Product } from "../modules/catalog/product.model.js";
import { IMAGE_TYPES, MAX_IMAGE_BYTES, UPLOAD_PURPOSES } from "../modules/uploads/upload-rules.js";
import { User } from "../modules/users/user.model.js";
import { SearchIndexer } from "../modules/search/search-indexer.js";
import { Vendor } from "../modules/vendors/vendor.model.js";
import { CATALOG_SNAPSHOT, CATEGORY_TREE, SEED_STORES, seedPrices, type SnapshotProduct } from "./catalog-data.js";

// Fills the marketplace with the demo catalogue: the category tree, five approved stores (plus one application
// waiting for the admin) and 214 products whose photos are copied into our own S3 bucket, then rebuilds the search
// index. Safe to run again:
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

async function seedCategories(): Promise<Map<string, Types.ObjectId>> {
  const bySourceCategory = new Map<string, Types.ObjectId>();
  for (const [i, dept] of CATEGORY_TREE.entries()) {
    const parent = await Category.findOneAndUpdate(
      { slug: slugify(dept.name) },
      { $set: { name: dept.name, parentId: null, isActive: true, sortOrder: i } },
      { upsert: true, returnDocument: "after" },
    );
    for (const [j, child] of dept.children.entries()) {
      const sub = await Category.findOneAndUpdate(
        { slug: slugify(child.name) },
        { $set: { name: child.name, parentId: parent._id, isActive: true, sortOrder: j } },
        { upsert: true, returnDocument: "after" },
      );
      for (const source of child.from) bySourceCategory.set(source, sub._id);
    }
  }
  return bySourceCategory;
}

async function seedStores(password: string, bcryptCost: number) {
  const passwordHash = await hashPassword(password, bcryptCost);
  const admin = await User.findOne({ email: "admin@shopsphere.test" });
  const vendorBySourceCategory = new Map<string, { id: Types.ObjectId; key: string }>();

  for (const store of SEED_STORES) {
    const user = await User.findOneAndUpdate(
      { email: store.owner.email },
      { $set: { role: "vendor", status: "active", passwordHash }, $setOnInsert: { name: store.owner.name } },
      { upsert: true, returnDocument: "after" },
    );
    const vendor = await Vendor.findOneAndUpdate(
      { userId: user._id },
      {
        $set: {
          storeName: store.storeName,
          slug: slugify(store.storeName),
          description: store.description,
          contactEmail: store.owner.email,
          phone: store.phone,
          ...(store.gstin && { gstin: store.gstin }),
          status: store.status,
          ...(store.status === "approved" && { approvedAt: new Date(), ...(admin && { approvedBy: admin._id }) }),
        },
        $unset: { rejectionReason: 1, ...(store.status !== "approved" && { approvedAt: 1, approvedBy: 1 }) },
        $setOnInsert: { submittedAt: new Date() },
      },
      { upsert: true, returnDocument: "after" },
    );
    for (const source of store.sells) vendorBySourceCategory.set(source, { id: vendor._id, key: vendor.id as string });
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

async function main() {
  const env = loadEnv();
  const withImages = !process.argv.includes("--no-images");
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) {
    throw new Error("Set DEMO_PASSWORD (10+ characters, letters and numbers) before seeding demo stores");
  }

  await connectMongo(env.MONGO_URL);
  const redis = createRedis(env.REDIS_URL);
  const s3 = createS3(env);
  if (env.S3_CREATE_BUCKET) await ensureBucket(s3, env.S3_BUCKET);
  const storage = createStorage(env, s3);
  await Promise.all([Category.init(), Vendor.init(), Product.init()]);

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
    const sku = `${p.source === "dummyjson" ? "DJ" : "FS"}-${p.sourceId}`;
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

    const save = (productSlug: string) =>
      Product.findOneAndUpdate(
        { vendorId: vendor.id, sku },
        {
          $set: {
            categoryId: category,
            title: p.title.slice(0, 150),
            slug: productSlug,
            description: p.description.slice(0, 5000),
            ...seedPrices(p),
            stock: p.stock,
            attributes: p.attributes,
            ratingAvg: Math.round(p.rating * 10) / 10,
            ratingCount: p.ratingCount,
            // A product needs a photo to be on sale, the same rule vendors follow.
            ...(withImages && { images: keys.map((key) => ({ key, alt: p.title.slice(0, 150) })), status: keys.length ? "active" : "draft" }),
            ...(p.brand && { brand: p.brand.slice(0, 60) }),
          },
          ...(!p.brand && { $unset: { brand: 1 } }),
          // Without --images a new product starts as a draft and an existing one keeps its photos and status.
          ...(!withImages && { $setOnInsert: { images: [], status: "draft" } }),
        },
        { upsert: true, runValidators: true },
      );
    // A vendor may already have their own product with this URL slug; then the seeded one gets a suffix.
    await save(slug).catch((err: unknown) => {
      if ((err as { code?: number }).code === 11000) return save(`${slug}-${sku.toLowerCase()}`);
      throw err;
    });
    saved++;
  });

  await Promise.all([invalidate(redis, cacheKeys.categories), invalidatePrefix(redis, cacheKeys.product(""))]);
  // Rebuild search from what was just saved, so it matches the catalogue exactly.
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const { indexed } = await new SearchIndexer(es, env.ES_INDEX).reindexAll();
  logger.info({ products: saved, photos, searchable: indexed, seconds: Math.round((Date.now() - started) / 1000) }, "demo catalogue ready");
  await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seeding the catalogue failed");
  process.exit(1);
});
