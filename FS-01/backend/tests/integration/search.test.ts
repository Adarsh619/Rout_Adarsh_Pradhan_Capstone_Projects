import type { Client } from "@elastic/elasticsearch";
import type { Express } from "express";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { Category } from "../../src/modules/catalog/category.model.js";
import { Product } from "../../src/modules/catalog/product.model.js";
import type { SearchIndexer } from "../../src/modules/search/search-indexer.js";
import { User } from "../../src/modules/users/user.model.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { approvedVendor, bearer, env, signInAdmin, startTestServices, uploadImage, wipe } from "./helpers.js";

let app: Express;
let redis: Redis;
let es: Client;
let indexer: SearchIndexer;

beforeAll(async () => {
  ({ app, redis, es, indexer } = await startTestServices());
  await Promise.all([User.init(), Vendor.init(), Category.init(), Product.init()]);
});

beforeEach(async () => {
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
});

const api = () => request(app);
const search = (query: string) => api().get(`/api/v1/search${query}`);
const titles = (res: request.Response) => res.body.items.map((p: { title: string }) => p.title);

// Two stores, two departments and a handful of products, published through the API (which updates search).
async function catalogue() {
  const admin = await signInAdmin(app);
  const cat = async (name: string, parentId?: string) =>
    (await api().post("/api/v1/admin/categories").set(bearer(admin)).send({ name, ...(parentId && { parentId }) })).body.category.id as string;
  const electronics = await cat("Electronics");
  const phones = await cat("Smartphones", electronics);
  const laptops = await cat("Laptops", electronics);
  const fashion = await cat("Fashion");
  const shirts = await cat("Shirts", fashion);

  const tech = await approvedVendor(app, admin, "tech@example.com", "Tech Bazaar");
  const style = await approvedVendor(app, admin, "style@example.com", "Style Street");
  const add = async (vendor: { token: string }, body: Record<string, unknown>) => {
    const key = await uploadImage(app, vendor.token);
    const res = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send({ description: "", stock: 10, status: "active", images: [{ key }], ...body });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body.product.id as string;
  };

  const ids = {
    iphone: await add(tech, { title: "iPhone 13 Pro", brand: "Apple", categoryId: phones, price: 9_399_900 }),
    galaxy: await add(tech, { title: "Galaxy S24", brand: "Samsung", categoryId: phones, price: 7_499_900 }),
    macbook: await add(tech, { title: "MacBook Air M2", brand: "Apple", categoryId: laptops, price: 9_999_900, stock: 0 }),
    // "iphone" only in the description: must rank below the product whose title says it.
    case: await add(tech, { title: "Clear Silicone Case", brand: "Spigen", categoryId: phones, price: 99_900, description: "Fits the iPhone 13 Pro perfectly" }),
    shirt: await add(style, { title: "Linen Shirt", brand: "Fabindia", categoryId: shirts, price: 199_900 }),
  };
  return { admin, tech, style, ids, phones, electronics };
}

describe("full-text search", () => {
  it("finds products despite typos and ranks title matches first", async () => {
    await catalogue();
    const res = await search("?q=iphne");
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(["iPhone 13 Pro", "Clear Silicone Case"]);
    expect(res.body.items[0]).toMatchObject({ brand: "Apple", price: 9_399_900, vendor: { slug: "tech-bazaar" }, inStock: true });
    expect(res.body.items[0].image.url).toMatch(/^http.*products\//);
  });

  it("matches words spread over brand, category and title", async () => {
    await catalogue();
    expect(titles(await search("?q=samsung%20smartphone"))).toEqual(["Galaxy S24"]);
    expect(titles(await search("?q=apple%20laptop"))).toEqual(["MacBook Air M2"]);
    expect((await search("?q=bicycle")).body.total).toBe(0);
  });

  it("understands everyday words for the same thing", async () => {
    await catalogue();
    // The category is "Smartphones"; shoppers type "phone" or "mobile".
    expect(titles(await search("?q=samsung%20phone"))).toEqual(["Galaxy S24"]);
    expect(titles(await search("?q=samsng%20mobile"))).toEqual(["Galaxy S24"]);
  });

  it("falls back to most of the words when nothing has all of them, and says so", async () => {
    await catalogue();
    const strict = await search("?q=linen%20shirt");
    expect(strict.body).toMatchObject({ total: 1, matchedAllWords: true });
    const relaxed = await search("?q=green%20linen%20shirt");
    expect(relaxed.body.matchedAllWords).toBe(false);
    expect(titles(relaxed)).toEqual(["Linen Shirt"]);
  });
});

describe("filters and facet counts", () => {
  it("narrows by department, brand, price and stock, with counts for each choice", async () => {
    await catalogue();
    const all = await search("");
    expect(all.body.total).toBe(5);
    expect(all.body.facets.categories).toEqual(
      expect.arrayContaining([{ slug: "smartphones", name: "Smartphones", count: 3 }, { slug: "shirts", name: "Shirts", count: 1 }]),
    );

    const apple = await search("?category=electronics&brand=Apple");
    expect(titles(apple).sort()).toEqual(["MacBook Air M2", "iPhone 13 Pro"]);
    // Other brands keep their counts, so a shopper can add them to the filter.
    expect(apple.body.facets.brands).toEqual(
      expect.arrayContaining([{ value: "Apple", count: 2 }, { value: "Samsung", count: 1 }, { value: "Spigen", count: 1 }]),
    );
    expect(apple.body.facets.inStock).toBe(1);

    expect(titles(await search("?brand=Apple&brand=Samsung&inStock=true&sort=price_asc"))).toEqual(["Galaxy S24", "iPhone 13 Pro"]);
    expect(titles(await search("?minPrice=100000&maxPrice=500000"))).toEqual(["Linen Shirt"]);
    expect(titles(await search("?vendor=style-street"))).toEqual(["Linen Shirt"]);
  });

  it("sorts by price both ways", async () => {
    await catalogue();
    const asc = titles(await search("?category=smartphones&sort=price_asc"));
    expect(asc).toEqual(["Clear Silicone Case", "Galaxy S24", "iPhone 13 Pro"]);
    expect(titles(await search("?category=smartphones&sort=price_desc"))).toEqual([...asc].reverse());
  });
});

describe("autocomplete", () => {
  it("suggests titles from the first letters, typos included", async () => {
    await catalogue();
    const res = await api().get("/api/v1/search/suggest?q=gal");
    expect(res.body.items).toEqual([{ id: expect.any(String), title: "Galaxy S24" }]);
    expect((await api().get("/api/v1/search/suggest?q=macbok")).body.items[0].title).toBe("MacBook Air M2");
    expect((await api().get("/api/v1/search/suggest?q=a")).status).toBe(400);
  });
});

describe("keeping search in step with the shop", () => {
  it("drops a product taken off sale and adds it back when republished", async () => {
    const { tech, ids } = await catalogue();
    await api().patch(`/api/v1/vendor/products/${ids.galaxy}`).set(bearer(tech.token)).send({ status: "inactive" });
    expect((await search("?q=galaxy")).body.total).toBe(0);
    await api().patch(`/api/v1/vendor/products/${ids.galaxy}`).set(bearer(tech.token)).send({ status: "active", price: 6_999_900 });
    expect((await search("?q=galaxy")).body.items[0].price).toBe(6_999_900);
    await api().delete(`/api/v1/vendor/products/${ids.galaxy}`).set(bearer(tech.token));
    expect((await search("?q=galaxy")).body.total).toBe(0);
  });

  it("hides every product of a suspended store, and brings them back on restore", async () => {
    const { admin, tech } = await catalogue();
    const storeId = (await api().get("/api/v1/vendors/me").set(bearer(tech.token))).body.store.id;
    await api().post(`/api/v1/admin/vendors/${storeId}/suspend`).set(bearer(admin)).send({ reason: "Policy violation" });
    expect((await search("")).body.total).toBe(1);
    await api().post(`/api/v1/admin/vendors/${storeId}/restore`).set(bearer(admin));
    expect((await search("")).body.total).toBe(5);
  });

  it("follows category renames and hides products of a hidden category", async () => {
    const { admin, phones } = await catalogue();
    await api().patch(`/api/v1/admin/categories/${phones}`).set(bearer(admin)).send({ name: "Mobile Phones" });
    expect(titles(await search("?q=mobile%20phones&sort=price_asc"))).toEqual(["Clear Silicone Case", "Galaxy S24", "iPhone 13 Pro"]);
    await api().patch(`/api/v1/admin/categories/${phones}`).set(bearer(admin)).send({ isActive: false });
    expect((await search("")).body.total).toBe(2);
  });

  it("rebuilds the whole index behind the alias without losing anything", async () => {
    const { ids } = await catalogue();
    // A product edited directly in the database (bypassing the API) is picked up by a rebuild.
    await Product.updateOne({ _id: ids.shirt }, { $set: { title: "Linen Kurta" } });
    const before = Object.keys(await es.indices.getAlias({ name: env.ES_INDEX }));
    const { indexed } = await indexer.reindexAll();
    expect(indexed).toBe(5);
    const after = Object.keys(await es.indices.getAlias({ name: env.ES_INDEX }));
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);
    expect(await es.indices.exists({ index: before[0]! })).toBe(false);
    expect(titles(await search("?q=kurta"))).toEqual(["Linen Kurta"]);
  });
});
