import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { Types } from "mongoose";
import { logger } from "../../lib/logger.js";
import type { SearchIndexer } from "./search-indexer.js";

export const SEARCH_QUEUE = "search-index";

export type SearchJob = { kind: "product" | "vendor" | "category"; id: string };

// What the API calls after a change that shoppers' search results depend on. The default sends a job to the worker,
// so the request never waits for Elasticsearch (and still succeeds if Elasticsearch is down).
export interface SearchSync {
  product(id: string | Types.ObjectId): Promise<void>;
  vendor(id: string | Types.ObjectId): Promise<void>;
  category(id: string | Types.ObjectId): Promise<void>;
}

// Retries with backoff (1 s, 2 s, 4 s …) cover Elasticsearch restarts; finished jobs are kept briefly for debugging.
const JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export function queuedSearchSync(connection: Redis): SearchSync & { queue: Queue } {
  const queue = new Queue<SearchJob>(SEARCH_QUEUE, { connection });
  const add = async (kind: SearchJob["kind"], id: string | Types.ObjectId) => {
    try {
      await queue.add(kind, { kind, id: String(id) }, JOB_OPTIONS);
    } catch (err) {
      // The change itself is saved; `npm run reindex` puts the index right if a job was lost.
      logger.error({ err, kind, id: String(id) }, "could not queue a search update");
    }
  };
  return {
    queue,
    product: (id) => add("product", id),
    vendor: (id) => add("vendor", id),
    category: (id) => add("category", id),
  };
}

// Applies changes straight away, for tests and scripts that need the index updated before they go on.
export function directSearchSync(indexer: SearchIndexer): SearchSync {
  return {
    product: async (id) => void (await indexer.syncProduct(id)),
    vendor: async (id) => void (await indexer.syncVendor(id)),
    category: async (id) => void (await indexer.syncCategory(id)),
  };
}

export const noSearchSync: SearchSync = { product: async () => {}, vendor: async () => {}, category: async () => {} };

// The worker's handler for one job.
export async function runSearchJob(indexer: SearchIndexer, job: SearchJob): Promise<string> {
  if (job.kind === "product") return indexer.syncProduct(job.id);
  const n = job.kind === "vendor" ? await indexer.syncVendor(job.id) : await indexer.syncCategory(job.id);
  return `${n} products indexed`;
}
