import { Redis } from "ioredis";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { connectMongo } from "../../src/lib/mongo.js";
import { createElasticsearch } from "../../src/lib/elasticsearch.js";
import { createS3, createStorage, ensureBucket } from "../../src/lib/s3.js";
import { SearchIndexer } from "../../src/modules/search/search-indexer.js";
import { directSearchSync } from "../../src/modules/search/search-sync.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { User } from "../../src/modules/users/user.model.js";

// Integration tests use their own MongoDB database and Redis database 15, and wipe them,
// so running them never touches development data.
export const TEST_DB = "shopsphere_test";
const TEST_REDIS_DB = 15;

export const env = loadEnv({
  ...process.env,
  NODE_ENV: "test",
  BCRYPT_COST: "4",
  // The local S3 mock unless CI says otherwise, and a bucket of its own.
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9090",
  S3_BUCKET: process.env.S3_BUCKET ?? "shopsphere-test",
  // Its own search alias, so tests never touch the development index.
  ES_INDEX: "products-test",
});

export function testRedis(): Redis {
  const url = new URL(env.REDIS_URL);
  url.pathname = `/${TEST_REDIS_DB}`;
  return new Redis(url.toString(), { maxRetriesPerRequest: null });
}

export async function startTestServices() {
  await connectMongo(env.MONGO_URL, TEST_DB);
  const redis = testRedis();
  const s3 = createS3(env);
  await ensureBucket(s3, env.S3_BUCKET);
  const storage = createStorage(env, s3);
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const indexer = new SearchIndexer(es, env.ES_INDEX);
  // A fresh index on every run, so tests always use the current mapping and synonyms.
  await indexer.reindexAll();
  // Search updates run inside the request here, so a test can search straight after a change.
  const app = createApp({ env, corsOrigins: ["http://localhost:3000"], redis, storage, es, searchSync: directSearchSync(indexer), healthChecks: {} });
  return { app, redis, storage, es, indexer };
}

// Empties every collection but keeps them and their indexes (dropping the whole database between tests
// races with MongoDB recreating collections on a replica set).
export async function wipe(redis: Redis) {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await redis.flushdb();
  await searchClient.deleteByQuery({ index: env.ES_INDEX, query: { match_all: {} }, refresh: true, conflicts: "proceed" }, { ignore: [404] });
}

// Shared by wipe(); a client doesn't connect until it's used.
const searchClient = createElasticsearch(env.ELASTICSEARCH_URL);

export const PASSWORD = "Sh0pSphere-test";

// Registers through the API and returns the access token plus the refresh cookie, like a browser would hold.
export async function register(
  app: Parameters<typeof request>[0],
  overrides: Partial<{ name: string; email: string; password: string; role: "customer" | "vendor" }> = {},
) {
  const body = { name: "Test User", email: "user@example.com", password: PASSWORD, role: "customer", ...overrides };
  const res = await request(app).post("/api/v1/auth/register").send(body);
  return { res, accessToken: res.body.accessToken as string, cookie: refreshCookie(res) };
}

export function refreshCookie(res: request.Response): string {
  const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((c) => c.startsWith("ss_refresh="));
  return raw ? raw.split(";")[0]! : "";
}

export const withCsrf = { "X-Requested-With": "ShopSphere" };

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

// Admins can't sign up, so tests create one directly and sign in through the API.
export async function signInAdmin(app: Parameters<typeof request>[0], email = "admin@example.com") {
  await User.create({ name: "Test Admin", email, passwordHash: await hashPassword(PASSWORD, 4), role: "admin" });
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  return res.body.accessToken as string;
}

export const storeApplication = (overrides: Record<string, unknown> = {}) => ({
  storeName: "Test Electronics",
  description: "Phones and laptops",
  contactEmail: "store@example.com",
  phone: "+91 98765 43210",
  ...overrides,
});

// A vendor account whose store an admin has approved.
export async function approvedVendor(app: Parameters<typeof request>[0], adminToken: string, email = "vendor@example.com", storeName = "Test Electronics") {
  const { accessToken } = await register(app, { email, role: "vendor", name: "Test Vendor" });
  const applied = await request(app).post("/api/v1/vendors/apply").set(bearer(accessToken)).send(storeApplication({ storeName }));
  await request(app).post(`/api/v1/admin/vendors/${applied.body.store.id}/approve`).set(bearer(adminToken));
  return { token: accessToken, storeId: applied.body.store.id as string, slug: applied.body.store.slug as string };
}

// Asks the API for an upload link and PUTs the bytes to it, exactly like the browser does.
export async function uploadImage(app: Parameters<typeof request>[0], token: string, opts: { contentType?: string; bytes?: number; purpose?: string } = {}) {
  const contentType = opts.contentType ?? "image/png";
  const body = new Uint8Array(opts.bytes ?? 1024).fill(7);
  const presign = await request(app)
    .post("/api/v1/uploads/presign")
    .set(bearer(token))
    .send({ purpose: opts.purpose ?? "product-image", contentType, size: body.byteLength });
  if (presign.status !== 201) throw new Error(`presign failed: ${presign.status} ${JSON.stringify(presign.body)}`);
  const put = await fetch(presign.body.uploadUrl as string, { method: "PUT", body, headers: presign.body.headers as Record<string, string> });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  return presign.body.key as string;
}
