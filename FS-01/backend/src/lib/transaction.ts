import { prisma, type Tx } from "./db.js";

// Runs a multi-row change in one PostgreSQL transaction (READ COMMITTED). Races are settled by conditional updates
// inside it (`updateMany where { id, status: from }`, `stock: { gte: qty }`), so a loser sees count 0 and the whole
// transaction rolls back when it throws.
export const inTransaction = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
  prisma.$transaction(fn, { maxWait: 5_000, timeout: 15_000 });
