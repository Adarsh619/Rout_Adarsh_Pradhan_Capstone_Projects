import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "../../lib/logger.js";

export const RESERVATION_QUEUE = "reservation-expiry";
export const SWEEP_JOB = "sweep";

// Hands stock back if an order isn't paid in time. Each order gets a delayed job for the moment its reservation
// runs out; a sweep every minute catches any order whose job was lost (Redis restored from an old snapshot, say).
export interface ReservationScheduler {
  schedule(orderId: string, expiresAt: Date): Promise<void>;
  // The order was paid or cancelled first, so its job has nothing to do.
  cancel(orderId: string): Promise<void>;
}

const jobId = (orderId: string) => `expire-${orderId}`;

export function queuedReservations(connection: Redis): ReservationScheduler & { queue: Queue } {
  const queue = new Queue<{ orderId: string }>(RESERVATION_QUEUE, { connection });
  return {
    queue,
    async schedule(orderId, expiresAt) {
      try {
        await queue.add(
          "expire",
          { orderId },
          {
            jobId: jobId(orderId),
            delay: Math.max(0, expiresAt.getTime() - Date.now()),
            attempts: 5,
            backoff: { type: "exponential", delay: 2000 },
            removeOnComplete: { age: 3600 },
            removeOnFail: { age: 7 * 24 * 3600 },
          },
        );
      } catch (err) {
        // The minute sweep still expires the order.
        logger.error({ err, orderId }, "could not schedule the reservation expiry");
      }
    },
    async cancel(orderId) {
      try {
        await queue.remove(jobId(orderId));
      } catch (err) {
        // Harmless: the job finds the order already paid and does nothing.
        logger.warn({ err, orderId }, "could not remove the reservation job");
      }
    },
  };
}

// The worker registers the minute sweep once; upserting keeps a single schedule however often the worker restarts.
export async function scheduleSweep(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(SWEEP_JOB, { every: 60_000 }, { name: SWEEP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
}

// Tests drive expiry themselves.
export const noReservations: ReservationScheduler = { schedule: async () => {}, cancel: async () => {} };
