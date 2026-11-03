import { Redis } from "ioredis";
import mongoose from "mongoose";
import request from "supertest";
import { createApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { connectMongo } from "../../src/lib/mongo.js";

// Integration tests use their own MongoDB database and Redis database 15, and wipe them,
// so running them never touches development data.
export const TEST_DB = "shopsphere_test";
const TEST_REDIS_DB = 15;

export const env = loadEnv({ ...process.env, NODE_ENV: "test", BCRYPT_COST: "4" });

export function testRedis(): Redis {
  const url = new URL(env.REDIS_URL);
  url.pathname = `/${TEST_REDIS_DB}`;
  return new Redis(url.toString(), { maxRetriesPerRequest: null });
}

export async function startTestServices() {
  await connectMongo(env.MONGO_URL, TEST_DB);
  const redis = testRedis();
  const app = createApp({ env, corsOrigins: ["http://localhost:3000"], redis, healthChecks: {} });
  return { app, redis };
}

// Empties every collection but keeps them and their indexes (dropping the whole database between tests
// races with MongoDB recreating collections on a replica set).
export async function wipe(redis: Redis) {
  const collections = await mongoose.connection.db!.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await redis.flushdb();
}

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
