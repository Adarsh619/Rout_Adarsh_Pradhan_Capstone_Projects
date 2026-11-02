import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { HealthCheck } from "./lib/health.js";
import { logger } from "./lib/logger.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { healthRouter } from "./routes/health.js";

export interface AppDeps {
  corsOrigins: string[];
  healthChecks: Record<string, HealthCheck>;
}

// Builds the Express app from its dependencies, so tests can pass fakes instead of real databases.
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  // One proxy hop (nginx locally, Caddy on the server) so req.ip is the real client address.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: deps.corsOrigins, credentials: true }));
  app.use(express.json({ limit: "100kb" }));
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/v1/health" } }));

  app.use("/api/v1/health", healthRouter(deps.healthChecks));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
