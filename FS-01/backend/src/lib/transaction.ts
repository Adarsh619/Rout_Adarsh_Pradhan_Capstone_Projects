import mongoose, { type ClientSession } from "mongoose";

// Runs a multi-document change in one MongoDB transaction. The driver retries the whole function on a transient
// error such as a write conflict (two checkouts touching the same product at the same moment), so `fn` must only
// depend on what it reads inside the transaction.
export const inTransaction = <T>(fn: (session: ClientSession) => Promise<T>): Promise<T> => mongoose.connection.transaction(fn);
