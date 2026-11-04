import { writeFile } from "node:fs/promises";
import { CATALOG_SNAPSHOT, type SnapshotProduct } from "./catalog-data.js";

// Downloads the demo catalogue from DummyJSON (194 products) and Fake Store (20) once and saves a trimmed copy in
// seed/catalog.json, which is committed. Seeding then never depends on those sites being up; only the photos are
// fetched from their CDNs (and copied into our own S3) when seeding.
//   npx tsx src/scripts/fetch-catalog-snapshot.ts

interface DummyProduct {
  id: number;
  title: string;
  description: string;
  category: string;
  price: number;
  discountPercentage: number;
  rating: number;
  stock: number;
  brand?: string;
  sku: string;
  weight?: number;
  dimensions?: { width: number; height: number; depth: number };
  warrantyInformation?: string;
  shippingInformation?: string;
  returnPolicy?: string;
  reviews: { rating: number; comment: string; date: string; reviewerName: string }[];
  images: string[];
  thumbnail: string;
}

interface FakeStoreProduct {
  id: number;
  title: string;
  price: number;
  description: string;
  category: string;
  image: string;
  rating: { rate: number; count: number };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const dummy = (p: DummyProduct): SnapshotProduct => ({
  source: "dummyjson",
  sourceId: p.id,
  title: p.title,
  description: p.description,
  brand: p.brand ?? null,
  sourceCategory: p.category,
  priceUsd: p.price,
  discountPercent: p.discountPercentage,
  stock: p.stock,
  rating: p.rating,
  // DummyJSON ships 3 sample reviews per product; Day 7 turns them into real review documents.
  ratingCount: p.reviews.length,
  images: (p.images.length ? p.images : [p.thumbnail]).slice(0, 3),
  attributes: Object.fromEntries(
    [
      ["Warranty", p.warrantyInformation],
      ["Shipping", p.shippingInformation],
      ["Returns", p.returnPolicy],
      ["Weight", p.weight ? `${p.weight} g` : undefined],
      ["Dimensions", p.dimensions ? `${p.dimensions.width} × ${p.dimensions.height} × ${p.dimensions.depth} cm` : undefined],
    ].filter((kv): kv is [string, string] => Boolean(kv[1])),
  ),
  // Reviewer emails are left out on purpose.
  reviews: p.reviews.map((r) => ({ rating: r.rating, comment: r.comment, date: r.date, reviewerName: r.reviewerName })),
});

const fakeStore = (p: FakeStoreProduct): SnapshotProduct => ({
  source: "fakestore",
  sourceId: p.id,
  title: p.title,
  description: p.description,
  brand: null,
  sourceCategory: p.category,
  priceUsd: p.price,
  discountPercent: 0,
  // Fake Store has no stock figure; a fixed spread keeps every seed run identical.
  stock: 15 + ((p.id * 37) % 120),
  rating: p.rating.rate,
  ratingCount: p.rating.count,
  images: [p.image],
  attributes: {},
  reviews: [],
});

async function main() {
  const [{ products: dummyProducts }, fakeProducts] = await Promise.all([
    getJson<{ products: DummyProduct[] }>("https://dummyjson.com/products?limit=0"),
    getJson<FakeStoreProduct[]>("https://fakestoreapi.com/products"),
  ]);
  const products = [...dummyProducts.map(dummy), ...fakeProducts.map(fakeStore)];
  await writeFile(CATALOG_SNAPSHOT, `${JSON.stringify({ fetchedAt: new Date().toISOString(), products }, null, 1)}\n`);
  console.log(`saved ${products.length} products to ${CATALOG_SNAPSHOT.pathname}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
