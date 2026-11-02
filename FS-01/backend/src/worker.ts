import { Worker } from "bullmq";
import { loadEnv } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { connectMongo, disconnectMongo } from "./lib/mongo.js";
import { createRedis } from "./lib/redis.js";

// Background worker: runs the slow jobs (search indexing, invoice PDFs, payouts, reservation expiry)
// outside the API process. Each later day adds its queue here; Day 1 only proves the worker connects.
export const QUEUES = ["search-index", "invoice-pdf", "payout", "reservation-expiry"] as const;

async function main(): Promise<void> {
  const env = loadEnv();
  await connectMongo(env.MONGO_URL);
  const connection = createRedis(env.REDIS_URL);

  const workers = QUEUES.map(
    (name) =>
      new Worker(
        name,
        async (job) => {
          logger.warn({ queue: name, job: job.name }, "no handler registered yet");
        },
        { connection },
      ),
  );
  logger.info({ queues: QUEUES }, "worker ready");

  const shutdown = async () => {
    await Promise.allSettled(workers.map((w) => w.close()));
    await Promise.allSettled([disconnectMongo(), connection.quit()]);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
