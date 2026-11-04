import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import { pinoHttp } from "pino-http";
import type { Env } from "./config/env.js";
import type { HealthCheck } from "./lib/health.js";
import { logger } from "./lib/logger.js";
import type { Storage } from "./lib/s3.js";
import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { authRouter, CSRF_HEADER } from "./modules/auth/auth.routes.js";
import { categoryRouter } from "./modules/catalog/category.routes.js";
import { productRouter } from "./modules/catalog/product.routes.js";
import type { RouteContext } from "./modules/context.js";
import { uploadRouter } from "./modules/uploads/upload.routes.js";
import { vendorRouter } from "./modules/vendors/vendor.routes.js";
import { SessionStore } from "./modules/auth/sessions.js";
import { AccessTokens } from "./modules/auth/tokens.js";
import { healthRouter } from "./routes/health.js";

export interface AppDeps {
  env: Env;
  corsOrigins: string[];
  redis: Redis;
  storage: Storage;
  healthChecks: Record<string, HealthCheck>;
}

// Builds the Express app from its dependencies, so tests can pass fakes instead of real services.
export function createApp(deps: AppDeps): Express {
  const { env } = deps;
  const app = express();
  app.disable("x-powered-by");
  // One proxy hop (nginx locally, Caddy on the server) so req.ip is the real client address.
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(
    cors({
      origin: deps.corsOrigins,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", CSRF_HEADER],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/v1/health" } }));

  const tokens = new AccessTokens(env.JWT_ACCESS_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  const sessions = new SessionStore(deps.redis, env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60);
  const { auth, account } = authRouter({
    redis: deps.redis,
    tokens,
    sessions,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshTtlDays: env.REFRESH_TOKEN_TTL_DAYS,
    cookieSecure: env.COOKIE_SECURE,
    cookieSameSite: env.COOKIE_SAME_SITE,
    bcryptCost: env.BCRYPT_COST,
  });

  app.use("/api/v1/health", healthRouter(deps.healthChecks));
  app.use("/api/v1/auth", auth);
  app.use("/api/v1/account", account);

  // Feature routers use full paths under /api/v1. Their handlers are plain async functions:
  // Express 5 passes a rejected promise to the error handler by itself.
  const ctx: RouteContext = { redis: deps.redis, storage: deps.storage, signedIn: requireAuth(tokens, sessions) };
  app.use("/api/v1", vendorRouter(ctx), categoryRouter(ctx), productRouter(ctx), uploadRouter(ctx));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
