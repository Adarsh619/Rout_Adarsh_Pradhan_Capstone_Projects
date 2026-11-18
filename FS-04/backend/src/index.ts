import { createApp } from "./app.js";
import { config } from "./config.js";
import { connectDb, disconnectDb } from "./lib/db.js";
import { logger } from "./lib/logger.js";
import { closeQueue } from "./jobs/queue.js";
import { startWorker } from "./jobs/worker.js";

// The API process. Migrations run before it starts (`prisma migrate deploy`, see the Dockerfile).
await connectDb(config.DATABASE_URL);
// EMBEDDED_WORKER=true also runs the background worker here: one Node process instead of two, which matters on the
// live site's 512 MB container. Docker Compose runs the worker as its own service instead.
const stopWorker = config.EMBEDDED_WORKER ? await startWorker(1) : null;
const server = createApp().listen(config.PORT, () => logger.info(`TaskFlow API listening on :${config.PORT}`));

async function shutdown(signal: string) {
  logger.info(`${signal}: shutting down`);
  server.close();
  await stopWorker?.();
  await closeQueue();
  await disconnectDb();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
