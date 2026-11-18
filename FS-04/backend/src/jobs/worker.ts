import { Worker } from "bullmq";
import { logger } from "../lib/logger.js";
import { getQueue, QUEUE_NAME, redisConnection, RetryLater } from "./queue.js";
import { runJob, SCHEDULE } from "./registry.js";

// Runs queued jobs and registers the recurring schedule (one process does both, so there is no separate
// scheduler, unlike v1's Celery worker + beat). Returns a function that stops it.
export async function startWorker(concurrency = Number(process.env.WORKER_CONCURRENCY ?? 2)): Promise<() => Promise<void>> {
  for (const { name, pattern } of SCHEDULE) {
    await getQueue().upsertJobScheduler(name, { pattern, tz: "UTC" }, { name, data: {} });
  }
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const result = await runJob(job.name, job.data as Record<string, unknown>);
      logger.info({ job: job.name, id: job.id, result }, "job done");
      return result;
    },
    { connection: redisConnection(), concurrency },
  );
  worker.on("failed", (job, err) => {
    const level = err instanceof RetryLater ? "info" : "error";
    logger[level]({ job: job?.name, id: job?.id, attempt: job?.attemptsMade, err: err.message }, "job failed");
  });
  logger.info(`TaskFlow worker started (${SCHEDULE.length} scheduled jobs)`);
  return () => worker.close();
}
