import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

export { Prisma };
// A transaction's client, or the main one: helpers that may run inside a transaction take one of these.
export type Tx = Prisma.TransactionClient;

// The one client for this process, created by connectDb() at start-up.
export let prisma: PrismaClient;

export async function connectDb(url: string): Promise<PrismaClient> {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 10 }) });
  await prisma.$connect();
  return prisma;
}

export async function pingDb(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDb(): Promise<void> {
  await prisma?.$disconnect();
}

// A unique constraint was violated (P2002): e.g. a repeated ledger key or webhook event, or a slug already taken.
export const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

// The row to update didn't match (P2025): with a conditional where, someone else changed it first.
export const isNotFound = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025";

// Next number of a named yearly sequence ("order-2026"), atomically: two checkouts never get the same number.
export async function nextSeq(name: string, tx: Tx = prisma): Promise<number> {
  const rows = await tx.$queryRaw<{ seq: number }[]>`
    INSERT INTO counters (id, seq) VALUES (${name}, 1)
    ON CONFLICT (id) DO UPDATE SET seq = counters.seq + 1
    RETURNING seq`;
  return rows[0]!.seq;
}
