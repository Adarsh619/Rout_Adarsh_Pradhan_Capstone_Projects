import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "../../lib/logger.js";
import { prisma, type Tx } from "../../lib/db.js";
import { inTransaction } from "../../lib/transaction.js";
import { record } from "./ledger.model.js";
import type { PaymentProvider } from "./payment-provider.js";
import type { PayoutProvider } from "./payout-provider.js";

// Calls to the outside world about money (refunds through Razorpay, payouts to vendors) run as background jobs:
// the request that caused them answers at once, and a failed call is retried with backoff until it succeeds.
export const MONEY_QUEUE = "payout";

export type MoneyJob = { kind: "payout" | "refund"; subOrderId: string };

export interface MoneyJobs {
  payout(subOrderId: string): Promise<void>;
  refund(subOrderId: string): Promise<void>;
}

export interface MoneyDeps {
  payments: PaymentProvider;
  payouts: PayoutProvider;
}

const JOB_OPTIONS: JobsOptions = {
  attempts: 10,
  backoff: { type: "exponential", delay: 5000 },
  removeOnComplete: { age: 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

export function queuedMoneyJobs(connection: Redis): MoneyJobs & { queue: Queue } {
  const queue = new Queue<MoneyJob>(MONEY_QUEUE, { connection });
  const add = async (kind: MoneyJob["kind"], subOrderId: string) => {
    try {
      // A fresh id each time, so a part can be retried later (finished jobs keep their id for a day).
      await queue.add(kind, { kind, subOrderId }, { ...JOB_OPTIONS, jobId: `${kind}-${subOrderId}-${Date.now()}` });
    } catch (err) {
      logger.error({ err, kind, subOrderId }, "could not queue a money job");
    }
  };
  return { queue, payout: (id) => add("payout", id), refund: (id) => add("refund", id) };
}

// Runs the job straight away (tests, scripts). Errors are logged, not thrown, like a queued job's would be.
export function directMoneyJobs(deps: MoneyDeps): MoneyJobs {
  const run = async (job: MoneyJob) => {
    try {
      await runMoneyJob(deps, job);
    } catch (err) {
      logger.warn({ err, job }, "money job failed");
    }
  };
  return { payout: (id) => run({ kind: "payout", subOrderId: id }), refund: (id) => run({ kind: "refund", subOrderId: id }) };
}

export const noMoneyJobs: MoneyJobs = { payout: async () => {}, refund: async () => {} };

export const MONEY_SWEEP_JOB = "sweep";

// Every hour the worker retries refunds and payouts that still haven't gone through: a provider may refuse for hours
// (Razorpay test accounts can refuse refunds until a payment settles), longer than one job's retries last.
export async function retryStuckMoney(deps: MoneyDeps, olderThanMs = 10 * 60_000): Promise<string> {
  const cutoff = new Date(Date.now() - olderThanMs);
  const [refunds, payouts] = await Promise.all([
    prisma.subOrder.findMany({
      where: { refundAmount: { gt: 0 }, refundProviderRef: null, refundRequestedAt: { lte: cutoff } },
      select: { id: true },
      take: 100,
    }),
    prisma.subOrder.findMany({
      where: { payoutStatus: { in: ["released", "failed"] }, payoutReleasedAt: { lte: cutoff } },
      select: { id: true },
      take: 100,
    }),
  ]);
  let done = 0;
  let failing = 0;
  const attempt = async (job: MoneyJob) => {
    try {
      await runMoneyJob(deps, job);
      done++;
    } catch (err) {
      failing++;
      logger.warn({ err: String(err), job }, "still failing; will retry in an hour");
    }
  };
  for (const s of refunds) await attempt({ kind: "refund", subOrderId: s.id });
  for (const s of payouts) await attempt({ kind: "payout", subOrderId: s.id });
  return `${done} retried, ${failing} still failing`;
}

// The hourly sweep is registered once; upserting keeps a single schedule however often the worker restarts.
export async function scheduleMoneySweep(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(MONEY_SWEEP_JOB, { every: 60 * 60_000 }, { name: MONEY_SWEEP_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } });
}

export async function runMoneyJob(deps: MoneyDeps, job: MoneyJob): Promise<string> {
  return job.kind === "payout" ? payOut(deps, job.subOrderId) : refundPart(deps, job.subOrderId);
}

// Pays a released share to the vendor. Safe to run again: the provider call uses the part id as its key, and the
// part only moves to "paid" (and the ledger only gets its entry) once.
export async function payOut(deps: MoneyDeps, subOrderId: string): Promise<string> {
  const sub = await prisma.subOrder.findUnique({ where: { id: subOrderId } });
  if (!sub?.payoutStatus) return "no share to pay";
  if (sub.payoutStatus === "paid") return "already paid";
  if (sub.payoutStatus !== "released" && sub.payoutStatus !== "failed") return `share is ${sub.payoutStatus}`;
  const vendor = await prisma.vendor.findUnique({ where: { id: sub.vendorId } });
  // Paid automatically as soon as the vendor adds payout details.
  if (vendor?.payoutStatus !== "active" || !vendor.payoutBeneficiaryRef) return "waiting for the vendor's payout details";

  let providerRef: string;
  try {
    ({ providerRef } = await deps.payouts.pay({ beneficiaryRef: vendor.payoutBeneficiaryRef, amount: sub.payoutAmount!, key: `payout-${subOrderId}` }));
  } catch (err) {
    await prisma.subOrder.updateMany({ where: { id: sub.id, payoutStatus: "released" }, data: { payoutStatus: "failed", payoutLastError: String(err) } });
    throw err;
  }
  const now = new Date();
  const paid = await inTransaction(async (tx) => {
    const [doc] = await tx.subOrder.updateManyAndReturn({
      where: { id: sub.id, payoutStatus: { in: ["released", "failed"] } },
      data: { payoutStatus: "paid", payoutPaidAt: now, payoutProvider: deps.payouts.name, payoutProviderRef: providerRef, payoutLastError: null },
    });
    if (!doc) return false;
    await record([{ type: "payout", orderId: doc.orderId, subOrderId: doc.id, vendorId: doc.vendorId, amount: doc.payoutAmount!, providerRef, note: "Simulated payout" }], tx);
    return true;
  });
  return paid ? `paid ${providerRef}` : "already paid";
}

// Refunds a cancelled part through the payment provider. The provider call is keyed by the part, so a retry after a
// crash finds the refund already made instead of refunding twice.
export async function refundPart(deps: MoneyDeps, subOrderId: string): Promise<string> {
  const sub = await prisma.subOrder.findUnique({ where: { id: subOrderId } });
  if (!sub?.refundAmount) return "nothing to refund";
  if (sub.refundProviderRef) return `already refunded (${sub.refundStatus})`;
  const order = await prisma.order.findUnique({ where: { id: sub.orderId } });
  const paymentId = order?.paymentProviderPaymentId;
  if (!order || !paymentId) return "order has no payment";

  let refund: { refundId: string; status: "processed" | "pending" };
  try {
    refund = await deps.payments.refund({ providerPaymentId: paymentId, amount: sub.refundAmount, key: `refund-${subOrderId}` });
  } catch (err) {
    // Shown to the customer as "couldn't be sent yet"; the job's retries and the hourly sweep keep trying.
    await prisma.subOrder.updateMany({ where: { id: sub.id, refundProviderRef: null }, data: { refundStatus: "failed", refundLastError: String(err) } });
    throw err;
  }
  await inTransaction(async (tx) => {
    const [doc] = await tx.subOrder.updateManyAndReturn({
      where: { id: sub.id, refundProviderRef: null },
      data: {
        refundProviderRef: refund.refundId,
        refundStatus: refund.status,
        refundLastError: null,
        ...(refund.status === "processed" && { refundProcessedAt: new Date() }),
      },
    });
    if (!doc) return;
    await record([{ type: "refund", orderId: doc.orderId, subOrderId: doc.id, vendorId: doc.vendorId, amount: doc.refundAmount!, providerRef: refund.refundId }], tx);
    await addRefundToOrder(doc.orderId, doc.refundAmount!, tx);
  });
  return `refund ${refund.refundId} ${refund.status}`;
}

// Keeps the order's payment status in step: partly refunded until everything paid has been returned.
export async function addRefundToOrder(orderId: string, amount: number, tx: Tx) {
  const [order] = await tx.order.updateManyAndReturn({ where: { id: orderId }, data: { refundedAmount: { increment: amount } } });
  if (!order) return;
  await tx.order.update({
    where: { id: orderId },
    data: { paymentStatus: order.refundedAmount >= order.grandTotal ? "refunded" : "partially_refunded" },
  });
}
