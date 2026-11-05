import type { Express } from "express";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import type { Storage } from "../../src/lib/s3.js";
import { Category } from "../../src/modules/catalog/category.model.js";
import { Product } from "../../src/modules/catalog/product.model.js";
import { User } from "../../src/modules/users/user.model.js";
import { Vendor } from "../../src/modules/vendors/vendor.model.js";
import { approvedVendor, bearer, register, signInAdmin, startTestServices, storeApplication, uploadImage, wipe } from "./helpers.js";

let app: Express;
let redis: Redis;
let storage: Storage;

beforeAll(async () => {
  ({ app, redis, storage } = await startTestServices());
  await Promise.all([User.init(), Vendor.init(), Category.init(), Product.init()]);
});

beforeEach(async () => {
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);

async function setup() {
  const admin = await signInAdmin(app);
  const dept = await api().post("/api/v1/admin/categories").set(bearer(admin)).send({ name: "Electronics" });
  const phones = await api()
    .post("/api/v1/admin/categories")
    .set(bearer(admin))
    .send({ name: "Smartphones", parentId: dept.body.category.id });
  const vendor = await approvedVendor(app, admin);
  return { admin, vendor, deptId: dept.body.category.id as string, categoryId: phones.body.category.id as string };
}

const product = (categoryId: string, overrides: Record<string, unknown> = {}) => ({
  title: "Galaxy Phone 128 GB",
  description: "A good phone",
  brand: "Samsung",
  categoryId,
  price: 1_999_900,
  mrp: 2_499_900,
  stock: 10,
  ...overrides,
});

describe("categories", () => {
  it("serves an active two-level tree, cached in Redis", async () => {
    const { admin, deptId } = await setup();
    const hidden = await api().post("/api/v1/admin/categories").set(bearer(admin)).send({ name: "Old Stuff", parentId: deptId });
    await api().patch(`/api/v1/admin/categories/${hidden.body.category.id}`).set(bearer(admin)).send({ isActive: false });

    const first = await api().get("/api/v1/categories");
    expect(first.headers["x-cache"]).toBe("MISS");
    expect(first.body.items).toEqual([
      { id: deptId, name: "Electronics", slug: "electronics", children: [expect.objectContaining({ name: "Smartphones", children: [] })] },
    ]);
    expect((await api().get("/api/v1/categories")).headers["x-cache"]).toBe("HIT");

    // Any change clears the cache, so the next read is fresh.
    await api().post("/api/v1/admin/categories").set(bearer(admin)).send({ name: "Laptops", parentId: deptId });
    const after = await api().get("/api/v1/categories");
    expect(after.headers["x-cache"]).toBe("MISS");
    expect(after.body.items[0].children.map((c: { name: string }) => c.name)).toEqual(["Laptops", "Smartphones"]);
  });

  it("stops at two levels and won't delete a category in use", async () => {
    const { admin, vendor, categoryId, deptId } = await setup();
    const third = await api().post("/api/v1/admin/categories").set(bearer(admin)).send({ name: "Too Deep", parentId: categoryId });
    expect(third.status).toBe(400);
    expect(third.body.error.details.fields[0].field).toBe("parentId");

    await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId));
    const del = await api().delete(`/api/v1/admin/categories/${categoryId}`).set(bearer(admin));
    expect(del.status).toBe(409);
    expect(del.body.error).toMatchObject({ code: "category_in_use", details: { products: 1 } });
    expect((await api().delete(`/api/v1/admin/categories/${deptId}`).set(bearer(admin))).body.error.details.subCategories).toBe(1);
  });

  it("keeps a category's order and commission when only hiding it", async () => {
    const { admin } = await setup();
    const created = await api().post("/api/v1/admin/categories").set(bearer(admin)).send({ name: "Toys", sortOrder: 5, commissionRateBp: 1200 });
    await api().patch(`/api/v1/admin/categories/${created.body.category.id}`).set(bearer(admin)).send({ isActive: false });
    const list = await api().get("/api/v1/admin/categories").set(bearer(admin));
    expect(list.body.items.find((c: { name: string }) => c.name === "Toys")).toMatchObject({ isActive: false, sortOrder: 5, commissionRateBp: 1200 });
  });

  it("is managed by admins only", async () => {
    const { vendor } = await setup();
    expect((await api().post("/api/v1/admin/categories").set(bearer(vendor.token)).send({ name: "Mine" })).status).toBe(403);
  });
});

describe("vendor products", () => {
  it("creates a draft, then publishes it once it has a photo", async () => {
    const { vendor, categoryId } = await setup();
    const created = await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId));
    expect(created.status).toBe(201);
    expect(created.body.product).toMatchObject({ status: "draft", slug: "galaxy-phone-128-gb", price: 1_999_900, mrp: 2_499_900 });
    const id = created.body.product.id as string;

    const noPhoto = await api().patch(`/api/v1/vendor/products/${id}`).set(bearer(vendor.token)).send({ status: "active" });
    expect(noPhoto.status).toBe(400);
    expect(noPhoto.body.error.details.fields).toEqual([{ field: "images", message: "Add at least one photo before publishing" }]);

    const key = await uploadImage(app, vendor.token);
    const published = await api()
      .patch(`/api/v1/vendor/products/${id}`)
      .set(bearer(vendor.token))
      .send({ status: "active", images: [{ key, alt: "Front view" }] });
    expect(published.status).toBe(200);
    expect(published.body.product.images[0]).toMatchObject({ key, alt: "Front view", url: expect.stringContaining(key) });

    // Now shoppers can see it, on the product page and the store page.
    const page = await api().get(`/api/v1/products/${id}`);
    expect(page.status).toBe(200);
    expect(page.body.product).toMatchObject({ title: "Galaxy Phone 128 GB", discountPercent: 20, inStock: true, vendor: { slug: vendor.slug } });
    expect(page.body.product.category).toMatchObject({ name: "Smartphones" });
    const store = await api().get(`/api/v1/stores/${vendor.slug}`);
    expect(store.body.products.items.map((p: { id: string }) => p.id)).toEqual([id]);
  });

  it("changes only the fields sent, keeping photos, specifications and description", async () => {
    const { vendor, categoryId } = await setup();
    const key = await uploadImage(app, vendor.token);
    const { body } = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(product(categoryId, { status: "active", images: [{ key, alt: "Front" }], attributes: { RAM: "8 GB" } }));
    const res = await api().patch(`/api/v1/vendor/products/${body.product.id}`).set(bearer(vendor.token)).send({ status: "inactive" });
    expect(res.body.product).toMatchObject({
      status: "inactive",
      images: [{ key, alt: "Front" }],
      attributes: { RAM: "8 GB" },
      description: "A good phone",
      price: 1_999_900,
    });
    expect(await storage.head(key)).not.toBeNull();
  });

  it("validates money and stock rules", async () => {
    const { vendor, categoryId } = await setup();
    const res = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(product(categoryId, { price: 50_000, mrp: 40_000, stock: -1 }));
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields.map((f: { field: string }) => f.field)).toEqual(["stock"]);

    const mrp = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(product(categoryId, { price: 50_000, mrp: 40_000 }));
    expect(mrp.body.error.details.fields).toEqual([{ field: "mrp", message: "MRP can't be lower than the selling price" }]);

    const fraction = await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId, { price: 199.5 }));
    expect(fraction.body.error.details.fields[0].field).toBe("price");

    const badCategory = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(product("0123456789abcdef01234567"));
    expect(badCategory.body.error.details.fields[0].field).toBe("categoryId");
  });

  it("keeps SKUs unique within a store", async () => {
    const { vendor, categoryId } = await setup();
    await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId, { sku: "SKU-1" }));
    const dup = await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId, { sku: "SKU-1" }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe("sku_taken");
  });

  it("only lets the owner see, edit or delete a product", async () => {
    const { admin, vendor, categoryId } = await setup();
    const other = await approvedVendor(app, admin, "other@example.com", "Other Store");
    const { body } = await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId));
    const id = body.product.id as string;

    // 404, not 403: another store's product ids don't exist as far as this vendor can tell.
    expect((await api().get(`/api/v1/vendor/products/${id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().patch(`/api/v1/vendor/products/${id}`).set(bearer(other.token)).send({ price: 100 })).status).toBe(404);
    expect((await api().delete(`/api/v1/vendor/products/${id}`).set(bearer(other.token))).status).toBe(404);
    expect((await api().get("/api/v1/vendor/products").set(bearer(other.token))).body.total).toBe(0);

    expect((await api().get("/api/v1/vendor/products").set(bearer(vendor.token))).body).toMatchObject({
      total: 1,
      counts: { draft: 1, active: 0, inactive: 0 },
    });
    expect((await api().delete(`/api/v1/vendor/products/${id}`).set(bearer(vendor.token))).status).toBe(204);
    expect(await Product.countDocuments()).toBe(0);
  });

  it("won't attach a photo from another store or one that was never uploaded", async () => {
    const { admin, vendor, categoryId } = await setup();
    const other = await approvedVendor(app, admin, "other@example.com", "Other Store");
    const theirs = await uploadImage(app, other.token);

    const res = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(
        product(categoryId, {
          images: [{ key: theirs }, { key: `products/${vendor.storeId}/never-uploaded.png` }],
        }),
      );
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields).toEqual([
      { field: "images.0", message: "This photo doesn't belong to your store" },
      { field: "images.1", message: "This photo didn't finish uploading. Please upload it again" },
    ]);
  });

  it("removes a photo from storage when the vendor takes it off the product", async () => {
    const { vendor, categoryId } = await setup();
    const [a, b] = [await uploadImage(app, vendor.token), await uploadImage(app, vendor.token)];
    const { body } = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(product(categoryId, { images: [{ key: a }, { key: b }] }));
    await api().patch(`/api/v1/vendor/products/${body.product.id}`).set(bearer(vendor.token)).send({ images: [{ key: b }] });
    await expect.poll(() => storage.head(a)).toBeNull();
    expect(await storage.head(b)).not.toBeNull();
  });

  it("needs an approved store", async () => {
    const { accessToken } = await register(app, { email: "new@example.com", role: "vendor" });
    const none = await api().get("/api/v1/vendor/products").set(bearer(accessToken));
    expect(none.status).toBe(403);
    expect(none.body.error).toMatchObject({ code: "vendor_not_approved", details: { storeStatus: "none" } });

    const applied = await api().post("/api/v1/vendors/apply").set(bearer(accessToken)).send(storeApplication());
    const pending = await api().post("/api/v1/uploads/presign").set(bearer(accessToken)).send({ purpose: "product-image", contentType: "image/png", size: 10 });
    expect(pending.body.error.details.storeStatus).toBe("pending");
    // A logo can already be uploaded while the application waits.
    const logo = await api().post("/api/v1/uploads/presign").set(bearer(accessToken)).send({ purpose: "store-logo", contentType: "image/png", size: 10 });
    expect(logo.status).toBe(201);
    expect(logo.body.key).toMatch(new RegExp(`^stores/${applied.body.store.id}/`));
  });
});

describe("what shoppers see", () => {
  it("hides drafts, and every product of a suspended store, straight away (cache included)", async () => {
    const { admin, vendor, categoryId } = await setup();
    const key = await uploadImage(app, vendor.token);
    const { body } = await api()
      .post("/api/v1/vendor/products")
      .set(bearer(vendor.token))
      .send(product(categoryId, { status: "active", images: [{ key }] }));
    const id = body.product.id as string;
    await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId, { title: "Hidden draft" }));

    expect((await api().get(`/api/v1/products/${id}`)).headers["x-cache"]).toBe("MISS");
    expect((await api().get(`/api/v1/products/${id}`)).headers["x-cache"]).toBe("HIT");
    // A department lists its sub-categories' products.
    const listed = await api().get("/api/v1/products?category=electronics");
    expect(listed.body.items.map((p: { title: string }) => p.title)).toEqual(["Galaxy Phone 128 GB"]);

    await api().post(`/api/v1/admin/vendors/${vendor.storeId}/suspend`).set(bearer(admin)).send({ reason: "Policy violation" });
    expect((await api().get(`/api/v1/products/${id}`)).status).toBe(404);
    expect((await api().get("/api/v1/products")).body.total).toBe(0);
    expect((await api().get(`/api/v1/stores/${vendor.slug}`)).status).toBe(404);
  });
});

describe("upload links", () => {
  it("only signs JPEG, PNG or WebP up to 5 MB", async () => {
    const { vendor } = await setup();
    const presign = (body: object) => api().post("/api/v1/uploads/presign").set(bearer(vendor.token)).send(body);

    const svg = await presign({ purpose: "product-image", contentType: "image/svg+xml", size: 100 });
    expect(svg.body.error.details.fields).toEqual([{ field: "contentType", message: "Photos must be JPEG, PNG or WebP" }]);
    const big = await presign({ purpose: "product-image", contentType: "image/jpeg", size: 5 * 1024 * 1024 + 1 });
    expect(big.body.error.details.fields).toEqual([{ field: "size", message: "Photos must be 5 MB or smaller" }]);

    const ok = await presign({ purpose: "product-image", contentType: "image/webp", size: 2048 });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/webp" }, expiresIn: 300 });
    expect(ok.body.key).toMatch(new RegExp(`^products/${vendor.storeId}/[0-9a-f-]{36}\\.webp$`));
    // Type and exact size are part of the signature, so the browser can't swap in a bigger or different file on AWS.
    expect(ok.body.uploadUrl).toMatch(/X-Amz-SignedHeaders=content-length%3Bcontent-type/);
  });

  it("rejects a file that was uploaded as something other than an image", async () => {
    const { vendor, categoryId } = await setup();
    const key = `products/${vendor.storeId}/sneaky.png`;
    await storage.put(key, new TextEncoder().encode("<html>not an image</html>"), "text/html");
    const res = await api().post("/api/v1/vendor/products").set(bearer(vendor.token)).send(product(categoryId, { images: [{ key }] }));
    expect(res.body.error.details.fields).toEqual([{ field: "images.0", message: "Photos must be JPEG, PNG or WebP" }]);
  });
});
