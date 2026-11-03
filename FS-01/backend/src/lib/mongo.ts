import mongoose from "mongoose";

// dbName overrides the database in the URL (tests use their own database so they never touch real data).
export async function connectMongo(url: string, dbName?: string): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  return mongoose.connect(url, { serverSelectionTimeoutMS: 10_000, ...(dbName && { dbName }) });
}

export async function pingMongo(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  await db.admin().ping();
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
