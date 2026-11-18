import { config } from "./config.js";
import { connectDb, disconnectDb } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { closeQueue } from "./jobs/queue.js";
import { startWorker } from "./jobs/worker.js";

// The background worker process (docker compose service "worker").
await connectDb(config.DATABASE_URL);
const stop = await startWorker();

async function shutdown(signal: string) {
  logger.info(`${signal}: worker shutting down`);
  await stop();
  await closeQueue();
  await disconnectDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
