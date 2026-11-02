import { createApp } from "./app.js";
import { corsOrigins, loadEnv } from "./config/env.js";
import { createElasticsearch, pingElasticsearch } from "./lib/elasticsearch.js";
import { logger } from "./lib/logger.js";
import { connectMongo, disconnectMongo, pingMongo } from "./lib/mongo.js";
import { createRedis, pingRedis } from "./lib/redis.js";
import { createS3, ensureBucket, pingS3 } from "./lib/s3.js";

async function main(): Promise<void> {
  const env = loadEnv();

  await connectMongo(env.MONGO_URL);
  const redis = createRedis(env.REDIS_URL);
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const s3 = createS3(env);
  if (env.S3_CREATE_BUCKET) await ensureBucket(s3, env.S3_BUCKET);

  const app = createApp({
    corsOrigins: corsOrigins(env),
    healthChecks: {
      mongo: pingMongo,
      redis: () => pingRedis(redis),
      elasticsearch: () => pingElasticsearch(es),
      s3: () => pingS3(s3, env.S3_BUCKET),
    },
  });

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, payments: env.PAYMENT_PROVIDER }, "API listening");
  });

  // Finish in-flight requests, then close connections, when Docker stops the container.
  const shutdown = (signal: string) => {
    logger.info({ signal }, "shutting down");
    server.close(async () => {
      await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "API failed to start");
  process.exit(1);
});
