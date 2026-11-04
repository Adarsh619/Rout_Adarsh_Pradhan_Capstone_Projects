import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { createStorage } from "../src/lib/s3.js";
import { slugify, uniqueSlug } from "../src/lib/slug.js";
import { buildTree, Category } from "../src/modules/catalog/category.model.js";
import { discountPercent } from "../src/modules/catalog/product.model.js";
import { checkUploadedImage, MAX_IMAGE_BYTES } from "../src/modules/uploads/upload-rules.js";
import { unitApp } from "./helpers/app.js";
import { memoryStorage } from "./helpers/memory-storage.js";

describe("slugs", () => {
  it("turns names into URL-safe slugs", () => {
    expect(slugify("Vikram's Electronics & More!")).toBe("vikrams-electronics-more");
    expect(slugify("  Café Délice  ")).toBe("cafe-delice");
    expect(slugify("!!!")).toBe("item");
    expect(slugify("a".repeat(100)).length).toBe(60);
  });

  it("adds a number when a slug is taken", async () => {
    const taken = new Set(["shop", "shop-2"]);
    expect(await uniqueSlug("Shop", async (s) => taken.has(s))).toBe("shop-3");
    expect(await uniqueSlug("New", async (s) => taken.has(s))).toBe("new");
  });
});

describe("money", () => {
  it("rounds the discount to a whole percent and never goes negative", () => {
    expect(discountPercent(1_999_900, 2_499_900)).toBe(20);
    expect(discountPercent(10_000, 10_000)).toBe(0);
    expect(discountPercent(10_000, 9_000)).toBe(0);
  });
});

describe("category tree", () => {
  it("nests active sub-categories under their department in order", () => {
    const dept = new Category({ name: "Electronics", slug: "electronics", sortOrder: 1 });
    const fashion = new Category({ name: "Fashion", slug: "fashion", sortOrder: 0 });
    const phones = new Category({ name: "Phones", slug: "phones", parentId: dept._id });
    const hidden = new Category({ name: "Pagers", slug: "pagers", parentId: dept._id, isActive: false });
    const tree = buildTree([dept, phones, hidden, fashion]);
    expect(tree.map((c) => c.name)).toEqual(["Fashion", "Electronics"]);
    expect(tree[1]!.children.map((c) => c.name)).toEqual(["Phones"]);
  });
});

describe("uploaded image checks", () => {
  const storage = memoryStorage();
  const prefix = "products/v1/";

  it("accepts a real image under the vendor's own prefix", async () => {
    storage.objects.set("products/v1/a.webp", { contentType: "image/webp", size: 1000 });
    expect(await checkUploadedImage(storage, "products/v1/a.webp", prefix)).toBeNull();
  });

  it("rejects other prefixes, path tricks, missing files, wrong types and big files", async () => {
    storage.objects.set("products/v1/page.png", { contentType: "text/html", size: 10 });
    storage.objects.set("products/v1/huge.jpg", { contentType: "image/jpeg", size: MAX_IMAGE_BYTES + 1 });
    expect(await checkUploadedImage(storage, "products/v2/a.webp", prefix)).toMatch(/doesn't belong/);
    expect(await checkUploadedImage(storage, "products/v1/../v2/a.webp", prefix)).toMatch(/doesn't belong/);
    expect(await checkUploadedImage(storage, "products/v1/missing.png", prefix)).toMatch(/didn't finish/);
    expect(await checkUploadedImage(storage, "products/v1/page.png", prefix)).toMatch(/JPEG, PNG or WebP/);
    expect(await checkUploadedImage(storage, "products/v1/huge.jpg", prefix)).toMatch(/5 MB/);
  });
});

describe("public file URLs", () => {
  it("point at the browser-facing S3 address locally and the bucket URL on AWS", () => {
    const local = createStorage(loadEnv({ S3_ENDPOINT: "http://s3:9090", S3_PUBLIC_ENDPOINT: "http://localhost:9090", S3_BUCKET: "bkt" }));
    expect(local.publicUrl("products/v1/a b.png")).toBe("http://localhost:9090/bkt/products/v1/a%20b.png");

    const aws = createStorage(loadEnv({ S3_BUCKET: "shopsphere-live", S3_REGION: "ap-south-1" }));
    expect(aws.publicUrl("products/v1/a.png")).toBe("https://shopsphere-live.s3.ap-south-1.amazonaws.com/products/v1/a.png");

    const cdn = createStorage(loadEnv({ S3_BUCKET: "bkt", S3_PUBLIC_URL: "https://cdn.example.com/" }));
    expect(cdn.publicUrl("products/v1/a.png")).toBe("https://cdn.example.com/products/v1/a.png");
  });

  it("signs upload links for the browser-facing address", async () => {
    const storage = createStorage(loadEnv({ S3_ENDPOINT: "http://s3:9090", S3_PUBLIC_ENDPOINT: "http://localhost:9090", S3_BUCKET: "bkt" }));
    const url = await storage.presignPut("products/v1/a.png", "image/png", 123, 300);
    expect(url).toMatch(/^http:\/\/localhost:9090\/bkt\/products\/v1\/a\.png\?/);
    expect(url).toMatch(/X-Amz-Expires=300/);
    expect(url).toMatch(/X-Amz-SignedHeaders=content-length%3Bcontent-type/);
    // No precomputed checksum: AWS would compare it with the real file and refuse the upload.
    expect(url).not.toMatch(/x-amz-checksum/i);
  });
});

describe("catalog routes without a session", () => {
  it("need sign-in for vendor and admin endpoints, and 404 for impossible ids", async () => {
    const app = unitApp();
    expect((await request(app).get("/api/v1/vendor/products")).status).toBe(401);
    expect((await request(app).post("/api/v1/uploads/presign").send({})).status).toBe(401);
    expect((await request(app).get("/api/v1/admin/vendors")).status).toBe(401);
    expect((await request(app).get("/api/v1/products/not-an-id")).status).toBe(404);
  });
});
