import type { Client } from "@elastic/elasticsearch";
import type { Types } from "mongoose";
import { logger } from "../../lib/logger.js";
import { Category, type CategoryDoc } from "../catalog/category.model.js";
import { discountPercent, Product, type ProductDoc } from "../catalog/product.model.js";
import { Vendor, type VendorDoc } from "../vendors/vendor.model.js";
import { INDEX_MAPPINGS, INDEX_SETTINGS, type ProductSearchDoc } from "./search-mapping.js";

// MongoDB is the source of truth; this keeps the Elasticsearch copy in step with it. Every method re-reads MongoDB,
// so running one twice, or late, or out of order, still leaves the index right (jobs can safely be retried).
export class SearchIndexer {
  constructor(
    private readonly es: Client,
    // The alias every search uses; real indexes are named <alias>-<timestamp>.
    readonly alias: string,
  ) {}

  // Creates the first index and points the alias at it, if there's no alias yet (fresh install).
  async ensureIndex(): Promise<void> {
    if (await this.es.indices.existsAlias({ name: this.alias })) return;
    const index = this.newIndexName();
    await this.es.indices.create({ index, settings: INDEX_SETTINGS, mappings: INDEX_MAPPINGS, aliases: { [this.alias]: {} } });
    logger.info({ alias: this.alias, index }, "search index created");
  }

  async syncProduct(id: string | Types.ObjectId): Promise<"indexed" | "removed"> {
    const product = await Product.findById(id);
    const doc = product ? await this.docFor(product) : null;
    if (doc) {
      await this.es.index({ index: this.alias, id: doc.id, document: doc, refresh: "wait_for" });
      return "indexed";
    }
    await this.remove([String(id)]);
    return "removed";
  }

  // A store was approved, suspended or renamed: every one of its products may need adding, removing or updating.
  async syncVendor(vendorId: string | Types.ObjectId): Promise<number> {
    const ids = await Product.find({ vendorId }).distinct("_id");
    return this.syncMany(ids);
  }

  // A category was renamed, hidden or shown (a department change affects its sub-categories too).
  async syncCategory(categoryId: string | Types.ObjectId): Promise<number> {
    const children = await Category.find({ parentId: categoryId }).distinct("_id");
    const ids = await Product.find({ categoryId: { $in: [categoryId, ...children] } }).distinct("_id");
    return this.syncMany(ids);
  }

  // Builds a complete new index from MongoDB, then switches the alias to it in one step and deletes the old one.
  // Searches keep working throughout, and products that no longer exist can't survive a rebuild.
  async reindexAll(): Promise<{ index: string; indexed: number }> {
    const index = this.newIndexName();
    await this.es.indices.create({ index, settings: { ...INDEX_SETTINGS, refresh_interval: "-1" }, mappings: INDEX_MAPPINGS });
    const lookups = await this.lookups();
    let indexed = 0;
    let batch: ProductSearchDoc[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const res = await this.es.bulk({ operations: batch.flatMap((d) => [{ index: { _index: index, _id: d.id } }, d]) });
      if (res.errors) throw new Error(`bulk indexing failed: ${JSON.stringify(res.items.find((i) => i.index?.error)?.index?.error)}`);
      indexed += batch.length;
      batch = [];
    };
    for await (const product of Product.find({ status: "active" }).cursor()) {
      const doc = this.buildDoc(product, lookups);
      if (doc) batch.push(doc);
      if (batch.length >= 500) await flush();
    }
    await flush();
    await this.es.indices.putSettings({ index, settings: { refresh_interval: "1s" } });
    await this.es.indices.refresh({ index });

    const old = (await this.es.indices.existsAlias({ name: this.alias }))
      ? Object.keys(await this.es.indices.getAlias({ name: this.alias }))
      : [];
    await this.es.indices.updateAliases({
      actions: [...old.map((i) => ({ remove: { index: i, alias: this.alias } })), { add: { index, alias: this.alias } }],
    });
    if (old.length) await this.es.indices.delete({ index: old });
    logger.info({ alias: this.alias, index, indexed, replaced: old }, "search index rebuilt");
    return { index, indexed };
  }

  private async syncMany(ids: Types.ObjectId[]): Promise<number> {
    if (!ids.length) return 0;
    const lookups = await this.lookups();
    const products = await Product.find({ _id: { $in: ids } });
    const docs = products.map((p) => this.buildDoc(p, lookups)).filter((d): d is ProductSearchDoc => d !== null);
    const keep = new Set(docs.map((d) => d.id));
    const operations = [
      ...docs.flatMap((d) => [{ index: { _index: this.alias, _id: d.id } }, d]),
      ...ids.map(String).filter((id) => !keep.has(id)).map((id) => ({ delete: { _index: this.alias, _id: id } })),
    ];
    const res = await this.es.bulk({ operations, refresh: "wait_for" });
    // Deleting something that isn't in the index answers 404 per item; that's fine.
    const failed = res.items.filter((i) => Object.values(i)[0]?.error && Object.values(i)[0]?.status !== 404);
    if (failed.length) throw new Error(`bulk sync failed for ${failed.length} products`);
    return docs.length;
  }

  private async remove(ids: string[]) {
    for (const id of ids) {
      await this.es.delete({ index: this.alias, id, refresh: "wait_for" }, { ignore: [404] });
    }
  }

  private async docFor(product: ProductDoc): Promise<ProductSearchDoc | null> {
    if (product.status !== "active") return null;
    const [vendor, category] = await Promise.all([Vendor.findById(product.vendorId), Category.findById(product.categoryId)]);
    const parent = category?.parentId ? await Category.findById(category.parentId) : null;
    const lookups = {
      vendors: new Map(vendor ? [[vendor.id as string, vendor]] : []),
      categories: new Map([category, parent].filter((c): c is CategoryDoc => c !== null).map((c) => [c.id as string, c])),
    };
    return this.buildDoc(product, lookups);
  }

  private async lookups() {
    const [vendors, categories] = await Promise.all([Vendor.find({ status: "approved" }), Category.find({ isActive: true })]);
    return {
      vendors: new Map(vendors.map((v) => [v.id as string, v])),
      categories: new Map(categories.map((c) => [c.id as string, c])),
    };
  }

  // null when shoppers mustn't find the product: not active, store not approved, or its category (or department) hidden.
  buildDoc(
    p: ProductDoc,
    { vendors, categories }: { vendors: Map<string, VendorDoc>; categories: Map<string, CategoryDoc> },
  ): ProductSearchDoc | null {
    const vendor = vendors.get(p.vendorId.toString());
    const category = categories.get(p.categoryId.toString());
    if (p.status !== "active" || !vendor || vendor.status !== "approved" || !category || !category.isActive) return null;
    const department = category.parentId ? categories.get(category.parentId.toString()) : null;
    if (category.parentId && (!department || !department.isActive)) return null;
    const image = p.images[0];
    return {
      id: p.id as string,
      title: p.title,
      suggest: p.title,
      description: p.description,
      brand: p.brand ?? null,
      categorySlug: category.slug,
      departmentSlug: department?.slug ?? null,
      categoryName: department ? `${department.name} ${category.name}` : category.name,
      categoryFacet: `${category.slug}|${category.name}`,
      vendorId: vendor.id as string,
      vendorSlug: vendor.slug,
      vendorName: vendor.storeName,
      vendorFacet: `${vendor.slug}|${vendor.storeName}`,
      price: p.price,
      mrp: p.mrp,
      discountPercent: discountPercent(p.price, p.mrp),
      ratingAvg: p.ratingAvg,
      ratingCount: p.ratingCount,
      stock: p.stock,
      inStock: p.stock > 0,
      imageKey: image?.key ?? null,
      imageAlt: image?.alt || p.title,
      createdAt: (p.createdAt as Date).toISOString(),
    };
  }

  private newIndexName() {
    return `${this.alias}-${Date.now()}`;
  }
}
