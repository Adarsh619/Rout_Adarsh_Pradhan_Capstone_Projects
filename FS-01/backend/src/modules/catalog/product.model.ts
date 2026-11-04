import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";
import type { Storage } from "../../lib/s3.js";
import type { CategoryDoc } from "./category.model.js";
import { toCategoryRef } from "./category.model.js";
import type { VendorDoc } from "../vendors/vendor.model.js";

export const PRODUCT_STATUSES = ["draft", "active", "inactive"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const MAX_IMAGES = 6;

const imageSchema = new Schema(
  {
    // S3 key under products/<vendorId>/, checked against what was actually uploaded before it is saved.
    key: { type: String, required: true },
    alt: { type: String, default: "", maxlength: 150 },
  },
  { _id: false },
);

const productSchema = new Schema(
  {
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    categoryId: { type: Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    title: { type: String, required: true, trim: true, minlength: 3, maxlength: 150 },
    slug: { type: String, required: true },
    description: { type: String, default: "", maxlength: 5000 },
    brand: { type: String, trim: true, maxlength: 60 },
    images: { type: [imageSchema], default: [] },
    // Money in integer paise: ₹499.00 is 49900.
    price: { type: Number, required: true, min: 100 },
    mrp: { type: Number, required: true },
    stock: { type: Number, required: true, min: 0, default: 0 },
    sku: { type: String, trim: true, maxlength: 40 },
    attributes: { type: Map, of: String, default: {} },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    // Set by checkout (Day 5); a product that has been ordered can't be deleted, only made inactive.
    soldCount: { type: Number, default: 0 },
    status: { type: String, enum: PRODUCT_STATUSES, default: "draft" },
  },
  { timestamps: true },
);

productSchema.index({ vendorId: 1, status: 1 });
productSchema.index({ vendorId: 1, slug: 1 }, { unique: true });
productSchema.index({ vendorId: 1, sku: 1 }, { unique: true, partialFilterExpression: { sku: { $type: "string" } } });
// Storefront lists until Elasticsearch takes over browsing on Day 4.
productSchema.index({ status: 1, createdAt: -1 });

export type ProductDoc = HydratedDocument<InferSchemaType<typeof productSchema>>;
export const Product = model("Product", productSchema);

export const discountPercent = (price: number, mrp: number) => (mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0);

const attributesOf = (p: ProductDoc) => Object.fromEntries((p.attributes as Map<string, string> | undefined) ?? new Map());

// The product as shoppers see it.
export function toPublicProduct(p: ProductDoc, vendor: VendorDoc, category: CategoryDoc | null, storage: Storage) {
  return {
    id: p.id as string,
    title: p.title,
    slug: p.slug,
    description: p.description,
    brand: p.brand ?? null,
    category: category ? toCategoryRef(category) : null,
    vendor: { id: vendor.id as string, storeName: vendor.storeName, slug: vendor.slug },
    images: p.images.map((img) => ({ url: storage.publicUrl(img.key), alt: img.alt || p.title })),
    price: p.price,
    mrp: p.mrp,
    discountPercent: discountPercent(p.price, p.mrp),
    inStock: p.stock > 0,
    stock: p.stock,
    attributes: attributesOf(p),
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    createdAt: (p.createdAt as Date).toISOString(),
  };
}

// A compact card for lists and grids.
export function toProductCard(p: ProductDoc, vendor: Pick<VendorDoc, "storeName" | "slug">, storage: Storage) {
  const first = p.images[0];
  return {
    id: p.id as string,
    title: p.title,
    brand: p.brand ?? null,
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

// The product as its own vendor sees it in the seller dashboard.
export function toVendorProduct(p: ProductDoc, storage: Storage) {
  return {
    id: p.id as string,
    title: p.title,
    slug: p.slug,
    description: p.description,
    brand: p.brand ?? null,
    categoryId: p.categoryId.toString(),
    images: p.images.map((img) => ({ key: img.key, alt: img.alt, url: storage.publicUrl(img.key) })),
    price: p.price,
    mrp: p.mrp,
    stock: p.stock,
    sku: p.sku ?? null,
    attributes: attributesOf(p),
    status: p.status as ProductStatus,
    soldCount: p.soldCount,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    createdAt: (p.createdAt as Date).toISOString(),
    updatedAt: (p.updatedAt as Date).toISOString(),
  };
}
