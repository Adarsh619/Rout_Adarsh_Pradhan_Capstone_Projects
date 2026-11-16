import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { connectDb, disconnectDb, nextSeq, pingDb, prisma } from "../../src/lib/db.js";
import { createElasticsearch, pingElasticsearch } from "../../src/lib/elasticsearch.js";
import { createRedis, pingRedis } from "../../src/lib/redis.js";
import { createS3, ensureBucket, pingS3 } from "../../src/lib/s3.js";
import { inTransaction } from "../../src/lib/transaction.js";
import { testDatabaseUrl } from "./global-setup.js";

// Proves the real services the app depends on are reachable and set up the way the app needs them.
const env = loadEnv({ ...process.env, S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9090" });
const redis = createRedis(env.REDIS_URL);
const es = createElasticsearch(env.ELASTICSEARCH_URL);
const s3 = createS3(env);

beforeAll(async () => {
  await connectDb(testDatabaseUrl(env.DATABASE_URL));
});

afterAll(async () => {
  await Promise.allSettled([disconnectDb(), redis.quit(), es.close()]);
});

describe("backing services", () => {
  it("PostgreSQL answers and has the migrated schema", async () => {
    await pingDb();
    const tables = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM pg_tables WHERE schemaname = 'public' AND tablename = 'orders'`;
    expect(Number(tables[0]!.n)).toBe(1);
  });

  it("a transaction that throws leaves nothing behind", async () => {
    const name = `test-${Date.now()}`;
    await expect(
      inTransaction(async (tx) => {
        await nextSeq(name, tx);
        throw new Error("roll back");
      }),
    ).rejects.toThrow("roll back");
    expect(await prisma.counter.findUnique({ where: { id: name } })).toBeNull();
  });

  it("sequences hand out each number once, even in parallel", async () => {
    const name = `test-par-${Date.now()}`;
    const numbers = await Promise.all(Array.from({ length: 20 }, () => nextSeq(name)));
    expect(new Set(numbers).size).toBe(20);
    expect(Math.max(...numbers)).toBe(20);
    await prisma.counter.delete({ where: { id: name } });
  });

  it("Redis answers", async () => {
    await pingRedis(redis);
  });

  it("Elasticsearch cluster is not red", async () => {
    await pingElasticsearch(es);
  });

  it("S3 bucket can be created and reached", async () => {
    await ensureBucket(s3, env.S3_BUCKET);
    await pingS3(s3, env.S3_BUCKET);
  });
});
