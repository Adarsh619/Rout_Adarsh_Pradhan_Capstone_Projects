import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "../generated/prisma/client.js";

export { Prisma };
// A transaction's client, or the main one: helpers that may run inside a transaction take one of these.
export type Tx = Prisma.TransactionClient;

// The one client for this process, created by connectDb() at start-up.
export let prisma: PrismaClient;

// SQL statements sent so far (counted only when connectDb is asked to; the performance tests use it).
export const stats = { queries: 0, recent: [] as string[] };

export async function connectDb(url: string, { countQueries = false } = {}): Promise<PrismaClient> {
  if (prisma) return prisma;
  const adapter = new PrismaPg({ connectionString: url, max: 10 });
  if (countQueries) {
    const client = new PrismaClient({ adapter, log: [{ emit: "event", level: "query" }] });
    client.$on("query", (e) => {
      stats.queries++;
      stats.recent.push(e.query);
      if (stats.recent.length > 50) stats.recent.shift();
    });
    prisma = client as unknown as PrismaClient;
  } else {
    prisma = new PrismaClient({ adapter });
  }
  await prisma.$connect();
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  await prisma?.$disconnect();
}

// A unique constraint was violated (P2002), e.g. two sign-ups with the same email at once.
export const isUniqueViolation = (err: unknown): boolean =>
  (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") ||
  // Raw-SQL partial unique indexes (one active sprint, one default workflow) surface as a driver error.
  (err instanceof Error && /unique constraint|duplicate key/i.test(err.message));

// Work that must only happen once the transaction has committed (queueing a job that reads the new rows).
export interface Unit {
  tx: Tx;
  after(fn: () => unknown): void;
}

// Run `fn` in one transaction; callbacks registered with `after` run only once it has committed.
export async function inTransaction<T>(fn: (unit: Unit) => Promise<T>): Promise<T> {
  const hooks: Array<() => unknown> = [];
  const result = await prisma.$transaction((tx) => fn({ tx, after: (h) => hooks.push(h) }), {
    timeout: 20_000,
    maxWait: 10_000,
  });
  for (const hook of hooks) await hook();
  return result;
}

// Lock one row until the transaction ends (Prisma has no SELECT … FOR UPDATE).
export async function lockRow(tx: Tx, table: string, id: number): Promise<void> {
  await tx.$executeRawUnsafe(`SELECT 1 FROM "${table}" WHERE id = $1 FOR UPDATE`, id);
}
