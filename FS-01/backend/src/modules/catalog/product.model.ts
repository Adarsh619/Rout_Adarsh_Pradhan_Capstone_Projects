import type { Category as CategoryRow, Product, ProductImage } from "../../generated/prisma/client.js";
import type { Storage } from "../../lib/s3.js";
import { toCategoryRef } from "./category.model.js";
import type { VendorRow } from "../vendors/vendor.model.js";

export const PRODUCT_STATUSES = ["draft", "active", "inactive"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const MAX_IMAGES = 6;

// A product row with its photos in display order. Every query that maps products uses `withImages`.
export type ProductRow = Product & { images: ProductImage[] };
export const withImages = { images: { orderBy: { position: "asc" } } } as const;

// The photo list as the API and the forms see it; stored as rows (product, position).
export const imageRows = (images: { key: string; alt: string }[]) => images.map((img, position) => ({ position, key: img.key, alt: img.alt }));

export const discountPercent = (price: number, mrp: number) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

const attributesOf = (p: Product): Record<string, string> => (p.attributes ?? {}) as Record<string, string>;

export function toPublicProduct(p: ProductRow, vendor: VendorRow, category: CategoryRow | null, storage: Storage) {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    description: p.description,
    brand: p.brand,
    category: category ? toCategoryRef(category) : null,
    vendor: { id: vendor.id, storeName: vendor.storeName, slug: vendor.slug },
    images: p.images.map((img) => ({ url: storage.publicUrl(img.key), alt: img.alt || p.title })),
    price: p.price,
    mrp: p.mrp,
    discountPercent: discountPercent(p.price, p.mrp),
    inStock: p.stock > 0,
    stock: p.stock,
    attributes: attributesOf(p),
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    createdAt: p.createdAt.toISOString(),
  };
}

export function toProductCard(p: ProductRow, vendor: Pick<VendorRow, "storeName" | "slug">, storage: Storage) {
  const first = p.images[0];
  return {
    id: p.id,
    title: p.title,
    brand: p.brand,
    image: first ? { url: storage.publicUrl(first.key), alt: first.alt || p.title } : null,
    price: p.price,
    mrp: p.mrp,
    discountPercent: discountPercent(p.price, p.mrp),
    inStock: p.stock > 0,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    vendor: { storeName: vendor.storeName, slug: vendor.slug },
  };
}

export function toVendorProduct(p: ProductRow, storage: Storage) {
  return {
    id: p.id,
    title: p.title,
    slug: p.slug,
    description: p.description,
    brand: p.brand,
    categoryId: p.categoryId,
    images: p.images.map((img) => ({ key: img.key, alt: img.alt, url: storage.publicUrl(img.key) })),
    price: p.price,
    mrp: p.mrp,
    stock: p.stock,
    sku: p.sku,
    attributes: attributesOf(p),
    status: p.status,
    soldCount: p.soldCount,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
