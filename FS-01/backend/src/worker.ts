import { Worker, type Job } from "bullmq";
import { loadEnv } from "./config/env.js";
import { createElasticsearch } from "./lib/elasticsearch.js";
import { logger } from "./lib/logger.js";
import { connectMongo, disconnectMongo } from "./lib/mongo.js";
import { createRedis } from "./lib/redis.js";
import { SearchIndexer } from "./modules/search/search-indexer.js";
import { runSearchJob, SEARCH_QUEUE, type SearchJob } from "./modules/search/search-sync.js";

// Background worker: runs the slow jobs (search indexing, invoice PDFs, payouts, reservation expiry)
// outside the API process. Each later day adds its handler here.
export const QUEUES = [SEARCH_QUEUE, "invoice-pdf", "payout", "reservation-expiry"] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  await connectMongo(env.MONGO_URL);
  const connection = createRedis(env.REDIS_URL);
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const indexer = new SearchIndexer(es, env.ES_INDEX);
  await indexer.ensureIndex();

  const handlers: Record<(typeof QUEUES)[number], (job: Job) => Promise<unknown>> = {
    [SEARCH_QUEUE]: (job: Job<SearchJob>) => runSearchJob(indexer, job.data),
    "invoice-pdf": async (job) => logger.warn({ queue: "invoice-pdf", job: job.name }, "no handler registered yet"),
    payout: async (job) => logger.warn({ queue: "payout", job: job.name }, "no handler registered yet"),
    "reservation-expiry": async (job) => logger.warn({ queue: "reservation-expiry", job: job.name }, "no handler registered yet"),
  };

  const workers = QUEUES.map((name) => {
    // Search updates are small and independent, so several run at once.
    const worker = new Worker(name, handlers[name], { connection, concurrency: name === SEARCH_QUEUE ? 4 : 1 });
    worker.on("completed", (job, result) => logger.debug({ queue: name, job: job.name, id: job.data?.id, result }, "job done"));
    worker.on("failed", (job, err) =>
      logger.warn({ queue: name, job: job?.name, id: job?.data?.id, attempt: job?.attemptsMade, err: err.message }, "job failed, will retry"),
    );
    return worker;
  });
  logger.info({ queues: QUEUES }, "worker ready");

  const shutdown = async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([disconnectMongo(), connection.quit(), es.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
