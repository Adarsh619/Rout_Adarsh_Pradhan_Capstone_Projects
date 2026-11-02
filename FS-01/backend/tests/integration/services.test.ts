import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { createElasticsearch, pingElasticsearch } from "../../src/lib/elasticsearch.js";
import { connectMongo, disconnectMongo, pingMongo } from "../../src/lib/mongo.js";
import { createRedis, pingRedis } from "../../src/lib/redis.js";
import { createS3, ensureBucket, pingS3 } from "../../src/lib/s3.js";
import mongoose from "mongoose";

// Proves the real services the app depends on are reachable and set up the way the app needs them.
const env = loadEnv({ ...process.env, S3_ENDPOINT: process.env.S3_ENDPOINT ?? "http://localhost:9090" });
const redis = createRedis(env.REDIS_URL);
const es = createElasticsearch(env.ELASTICSEARCH_URL);
const s3 = createS3(env);

beforeAll(async () => {
  await connectMongo(env.MONGO_URL);
});

afterAll(async () => {
  await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
});

describe("backing services", () => {
  it("MongoDB answers and runs as a replica set (needed for transactions at checkout)", async () => {
    await pingMongo();
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    expect(hello.setName).toBe("rs0");
  });

  it("MongoDB commits a multi-document transaction", async () => {
    const coll = mongoose.connection.db!.collection("integration_tx");
    const session = await mongoose.startSession();
    await session.withTransaction(async () => {
      await coll.insertOne({ n: 1 }, { session });
      await coll.insertOne({ n: 2 }, { session });
    });
    await session.endSession();
    expect(await coll.countDocuments()).toBeGreaterThanOrEqual(2);
    await coll.drop();
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
