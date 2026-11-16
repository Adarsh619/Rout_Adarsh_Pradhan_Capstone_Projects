import type { Client } from "@elastic/elasticsearch";
import { prisma } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import type { CategoryRow } from "../catalog/category.model.js";
import { discountPercent, withImages, type ProductRow } from "../catalog/product.model.js";
import type { VendorRow } from "../vendors/vendor.model.js";
import { INDEX_MAPPINGS, INDEX_SETTINGS, type ProductSearchDoc } from "./search-mapping.js";

// PostgreSQL is the source of truth; this keeps the Elasticsearch copy in step with it. Every method re-reads the database,
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

  async syncProduct(id: string): Promise<"indexed" | "removed"> {
    const product = await prisma.product.findUnique({ where: { id }, include: withImages });
    const doc = product ? await this.docFor(product) : null;
    if (doc) {
      await this.es.index({ index: this.alias, id: doc.id, document: doc, refresh: "wait_for" });
      return "indexed";
    }
    await this.remove([id]);
    return "removed";
  }

  // A store was approved, suspended or renamed: every one of its products may need adding, removing or updating.
  async syncVendor(vendorId: string): Promise<number> {
    const rows = await prisma.product.findMany({ where: { vendorId }, select: { id: true } });
    return this.syncMany(rows.map((r) => r.id));
  }

  // A category was renamed, hidden or shown (a department change affects its sub-categories too).
  async syncCategory(categoryId: string): Promise<number> {
    const rows = await prisma.product.findMany({
      where: { OR: [{ categoryId }, { category: { parentId: categoryId } }] },
      select: { id: true },
    });
    return this.syncMany(rows.map((r) => r.id));
  }

  // Builds a complete new index from the database, then switches the alias to it in one step and deletes the old one.
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
    // Read in pages of 500 (keyset on id), so memory stays flat however big the catalogue gets.
    let after: string | undefined;
    for (;;) {
      const page = await prisma.product.findMany({
        where: { status: "active", ...(after && { id: { gt: after } }) },
        orderBy: { id: "asc" },
        take: 500,
        include: withImages,
      });
      if (!page.length) break;
      for (const product of page) {
        const doc = this.buildDoc(product, lookups);
        if (doc) batch.push(doc);
      }
      await flush();
      after = page[page.length - 1]!.id;
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

  private async syncMany(ids: string[]): Promise<number> {
    if (!ids.length) return 0;
    const lookups = await this.lookups();
    const products = await prisma.product.findMany({ where: { id: { in: ids } }, include: withImages });
    const docs = products.map((p) => this.buildDoc(p, lookups)).filter((d): d is ProductSearchDoc => d !== null);
    const keep = new Set(docs.map((d) => d.id));
    const operations = [
      ...docs.flatMap((d) => [{ index: { _index: this.alias, _id: d.id } }, d]),
      ...ids.filter((id) => !keep.has(id)).map((id) => ({ delete: { _index: this.alias, _id: id } })),
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

  private async docFor(product: ProductRow): Promise<ProductSearchDoc | null> {
    if (product.status !== "active") return null;
    const [vendor, category] = await Promise.all([
      prisma.vendor.findUnique({ where: { id: product.vendorId } }),
      prisma.category.findUnique({ where: { id: product.categoryId }, include: { parent: true } }),
    ]);
    const lookups = {
      vendors: new Map(vendor ? [[vendor.id, vendor]] : []),
      categories: new Map([category, category?.parent ?? null].filter((c): c is CategoryRow => c !== null).map((c) => [c.id, c])),
    };
    return this.buildDoc(product, lookups);
  }

  private async lookups() {
    const [vendors, categories] = await Promise.all([
      prisma.vendor.findMany({ where: { status: "approved" } }),
      prisma.category.findMany({ where: { isActive: true } }),
    ]);
    return {
      vendors: new Map(vendors.map((v) => [v.id, v])),
      categories: new Map(categories.map((c) => [c.id, c])),
    };
  }

  // null when shoppers mustn't find the product: not active, store not approved, or its category (or department) hidden.
  buildDoc(
    p: ProductRow,
    { vendors, categories }: { vendors: Map<string, VendorRow>; categories: Map<string, CategoryRow> },
  ): ProductSearchDoc | null {
    const vendor = vendors.get(p.vendorId);
    const category = categories.get(p.categoryId);
    if (p.status !== "active" || !vendor || vendor.status !== "approved" || !category || !category.isActive) return null;
    const department = category.parentId ? categories.get(category.parentId) : null;
    if (category.parentId && (!department || !department.isActive)) return null;
    const image = p.images[0];
    return {
      id: p.id,
      title: p.title,
      suggest: p.title,
      description: p.description,
      brand: p.brand,
      categorySlug: category.slug,
      departmentSlug: department?.slug ?? null,
      categoryName: department ? `${department.name} ${category.name}` : category.name,
      categoryFacet: `${category.slug}|${category.name}`,
      vendorId: vendor.id,
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
      createdAt: p.createdAt.toISOString(),
    };
  }

  private newIndexName() {
    return `${this.alias}-${Date.now()}`;
  }
}
