import { randomUUID } from "node:crypto";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";

// Background jobs (BullMQ on Redis, the Node counterpart of v1's Celery). The API only queues job names and ids;
// the worker (src/worker.ts) runs them. With JOBS_INLINE=true they run right here instead (tests, quick local dev).

export const QUEUE_NAME = "taskflow";

export type JobName =
  | "deliver_webhook"
  | "send_notification_emails"
  | "generate_weekly_report"
  | "generate_all_weekly_reports"
  | "send_due_date_reminders"
  | "delete_old_webhook_deliveries"
  | "reset_demo_data"
  | "purge_visitor_data";

// Thrown by a job that should be tried again later (e.g. a webhook receiver answered 503).
export class RetryLater extends Error {}

// Webhook deliveries are tried up to 5 times: 30 s, 60 s, 120 s and 240 s apart.
export const RETRY_OPTIONS: Partial<Record<JobName, { attempts: number; backoff: { type: "exponential"; delay: number } }>> = {
  deliver_webhook: { attempts: 5, backoff: { type: "exponential", delay: 30_000 } },
};

let connection: Redis | undefined;
let queue: Queue | undefined;

export function redisConnection(): Redis {
  connection ??= new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

function getQueue(): Queue {
  queue ??= new Queue(QUEUE_NAME, {
    connection: redisConnection(),
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 5000 },
  });
  return queue;
}

// Tests can hold queued jobs here instead of running them (then run a job by hand to control what it sees).
export const testing: { held: Array<{ name: JobName; data: Record<string, unknown> }> | null } = { held: null };

// Queue a job; returns its id. Inline mode runs it now (retries included) and swallows its errors like a worker.
export async function enqueue(name: JobName, data: Record<string, unknown> = {}): Promise<string> {
  if (testing.held) {
    testing.held.push({ name, data });
    return randomUUID();
  }
  if (config.JOBS_INLINE) {
    const id = randomUUID();
    const { runJob } = await import("./registry.js");
    const attempts = RETRY_OPTIONS[name]?.attempts ?? 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await runJob(name, data);
        break;
      } catch (err) {
        if (!(err instanceof RetryLater)) {
          logger.error({ err, job: name }, "inline job failed");
          break;
        }
      }
    }
    return id;
  }
  const job = await getQueue().add(name, data, RETRY_OPTIONS[name] ?? {});
  return job.id ?? "";
}

export async function closeQueue(): Promise<void> {
  await queue?.close();
  await connection?.quit().catch(() => undefined);
  queue = undefined;
  connection = undefined;
}

export { getQueue };
