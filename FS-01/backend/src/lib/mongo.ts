import mongoose from "mongoose";

export async function connectMongo(url: string): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  return mongoose.connect(url, { serverSelectionTimeoutMS: 10_000 });
}

export async function pingMongo(): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error("not connected");
  await db.admin().ping();
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
