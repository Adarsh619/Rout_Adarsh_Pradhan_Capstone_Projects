import { createApp } from "./app.js";
import { corsOrigins, loadEnv } from "./config/env.js";
import { createElasticsearch, pingElasticsearch } from "./lib/elasticsearch.js";
import { logger } from "./lib/logger.js";
import { connectMongo, disconnectMongo, pingMongo } from "./lib/mongo.js";
import { createRedis, pingRedis } from "./lib/redis.js";
import { createS3, createStorage, ensureBucket, pingS3 } from "./lib/s3.js";
import { SearchIndexer } from "./modules/search/search-indexer.js";
import { queuedReservations } from "./modules/orders/reservations.js";
import { queuedInvoiceJobs } from "./modules/invoices/invoice-jobs.js";
import { queuedMoneyJobs } from "./modules/payments/money-jobs.js";
import { createPaymentProvider } from "./modules/payments/payment-provider.js";
import { MockPayoutProvider } from "./modules/payments/payout-provider.js";
import { queuedSearchSync } from "./modules/search/search-sync.js";

async function main(): Promise<void> {
  const env = loadEnv();

  await connectMongo(env.MONGO_URL);
  const redis = createRedis(env.REDIS_URL);
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const s3 = createS3(env);
  if (env.S3_CREATE_BUCKET) await ensureBucket(s3, env.S3_BUCKET);
  // A fresh install gets an empty search index straight away; `npm run reindex` (or the seed) fills it.
  await new SearchIndexer(es, env.ES_INDEX).ensureIndex();
  const searchSync = queuedSearchSync(redis);
  const reservations = queuedReservations(redis);
  const moneyJobs = queuedMoneyJobs(redis);
  const invoiceJobs = queuedInvoiceJobs(redis);

  const app = createApp({
    env,
    corsOrigins: corsOrigins(env),
    redis,
    storage: createStorage(env, s3),
    es,
    searchSync,
    payments: createPaymentProvider(env.PAYMENT_PROVIDER, env.JWT_ACCESS_SECRET, { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }),
    payouts: new MockPayoutProvider(),
    moneyJobs,
    invoiceJobs,
    reservations,
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
      await Promise.allSettled([searchSync.queue.close(), reservations.queue.close(), moneyJobs.queue.close(), invoiceJobs.queue.close(), disconnectMongo(), redis.quit(), es.close()]);
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
