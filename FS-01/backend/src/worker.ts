import { Worker, type Job } from "bullmq";
import { loadEnv } from "./config/env.js";
import { createElasticsearch } from "./lib/elasticsearch.js";
import { logger } from "./lib/logger.js";
import { connectMongo, disconnectMongo } from "./lib/mongo.js";
import { createRedis } from "./lib/redis.js";
import { SearchIndexer } from "./modules/search/search-indexer.js";
import { expireDueOrders, releaseReservation } from "./modules/orders/order-service.js";
import { queuedReservations, RESERVATION_QUEUE, scheduleSweep, SWEEP_JOB } from "./modules/orders/reservations.js";
import { directSearchSync, runSearchJob, SEARCH_QUEUE, type SearchJob } from "./modules/search/search-sync.js";

// Background worker: runs the slow jobs (search indexing, invoice PDFs, payouts, reservation expiry)
// outside the API process. Each later day adds its handler here.
export const QUEUES = [SEARCH_QUEUE, "invoice-pdf", "payout", RESERVATION_QUEUE] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  await connectMongo(env.MONGO_URL);
  const connection = createRedis(env.REDIS_URL);
  const es = createElasticsearch(env.ELASTICSEARCH_URL);
  const indexer = new SearchIndexer(es, env.ES_INDEX);
  await indexer.ensureIndex();
  // Stock handed back by an expired order is indexed straight away (the worker is already the background process).
  const reservations = queuedReservations(connection);
  const orderDeps = { redis: connection, searchSync: directSearchSync(indexer), reservations };
  await scheduleSweep(reservations.queue);

  const handlers: Record<(typeof QUEUES)[number], (job: Job) => Promise<unknown>> = {
    [SEARCH_QUEUE]: (job: Job<SearchJob>) => runSearchJob(indexer, job.data),
    "invoice-pdf": async (job) => logger.warn({ queue: "invoice-pdf", job: job.name }, "no handler registered yet"),
    payout: async (job) => logger.warn({ queue: "payout", job: job.name }, "no handler registered yet"),
    [RESERVATION_QUEUE]: async (job: Job<{ orderId?: string }>) => {
      if (job.name === SWEEP_JOB) return `${await expireDueOrders(orderDeps)} orders expired`;
      const released = await releaseReservation(orderDeps, job.data.orderId!, { to: "expired", reason: "Not paid in time", actor: { role: "system" }, onlyIfDue: true });
      return released ? "expired" : "already paid or ended";
    },
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
    await Promise.allSettled([reservations.queue.close(), disconnectMongo(), connection.quit(), es.close()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
