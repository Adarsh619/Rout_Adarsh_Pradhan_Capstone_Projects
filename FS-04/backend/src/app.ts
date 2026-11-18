import "./lib/request.js";
import "./lib/validate.js";
import cors from "cors";
import express, { type ErrorRequestHandler, type Request, type RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { pinoHttp } from "pino-http";
import { config, parseRate } from "./config.js";
import { HttpError } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { auditRouter } from "./modules/audit/routes.js";
import { readUser, requireUser } from "./modules/auth/middleware.js";
import { authRouter } from "./modules/auth/routes.js";
import { billingRouter, stripeWebhook } from "./modules/billing/routes.js";
import { notificationsRouter, reportsRouter, webhooksRouter } from "./modules/integrations/routes.js";
import { docsRouter } from "./modules/openapi.js";
import { membersRouter, workspacesRouter } from "./modules/tenancy/routes.js";
import { attachmentsRouter } from "./modules/tracker/attachments.js";
import { boardsRouter, projectsRouter, sprintsRouter } from "./modules/tracker/projects.js";
import { commentsRouter, issuesRouter } from "./modules/tracker/issues.js";
import { statusesRouter, transitionsRouter, workflowsRouter } from "./modules/tracker/workflows.js";

// Throttled answers keep the v1 wording.
function limiter(rate: string, key: (req: Request) => string): RequestHandler {
  const { limit, windowMs } = parseRate(rate);
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: key,
    handler: (_req, res, _next, options) => {
      const wait = Math.ceil(((res.getHeader("RateLimit-Reset") as number | undefined) ?? options.windowMs / 1000));
      res.status(429).json({ detail: `Request was throttled. Expected available in ${wait} seconds.` });
    },
  });
}

// Per user when signed in, else per IP (IPv6 addresses grouped by /56, so one host can't rotate through its range).
const byUserOrIp = (req: Request) => (req.user ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`);

export const UNKNOWN_ENDPOINT = "No such API endpoint.";

export function createApp() {
  const app = express();
  // How many proxies (nginx, and on the live site Render's) sit in front: decides which X-Forwarded-For entry
  // is the client address used by the audit log and the rate limits. 0 ignores the header.
  app.set("trust proxy", config.TRUSTED_PROXY_COUNT);
  app.set("etag", false);
  app.disable("x-powered-by");

  if (!process.env.VITEST) app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === "/api/health/" } }));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
  app.use(cors({ origin: config.CORS_ALLOWED_ORIGINS, allowedHeaders: ["accept", "authorization", "content-type", "origin", "x-requested-with", "x-workspace"] }));

  // Doesn't touch the database, so uptime checks don't keep a scale-to-zero database awake.
  // APP_VERSION (the deployed commit) lets CI wait until a new deploy is actually live.
  app.get("/api/health/", (_req, res) => {
    res.json({ status: "ok", version: config.APP_VERSION });
  });

  // Stripe signs the exact bytes it sends, so this route reads the raw body (before the JSON parser).
  app.post("/api/billing/stripe-webhook/", express.raw({ type: "*/*", limit: "1mb" }), stripeWebhook);

  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use("/api", readUser);

  const authLimit = limiter(config.AUTH_RATE_LIMIT, byUserOrIp);
  const userLimit = limiter(config.API_RATE_LIMIT, byUserOrIp);

  app.use("/api", docsRouter());
  app.use("/api/auth", authRouter(authLimit));

  const api = express.Router();
  api.use(requireUser, userLimit);
  api.use("/billing", billingRouter());
  api.use("/workspaces", workspacesRouter());
  api.use("/members", membersRouter());
  api.use("/workflows", workflowsRouter());
  api.use("/statuses", statusesRouter());
  api.use("/transitions", transitionsRouter());
  api.use("/projects", projectsRouter());
  api.use("/boards", boardsRouter());
  api.use("/sprints", sprintsRouter());
  api.use("/issues", issuesRouter());
  api.use("/comments", commentsRouter());
  api.use("/attachments", attachmentsRouter());
  api.use("/audit-logs", auditRouter());
  api.use("/webhooks", webhooksRouter());
  api.use("/notifications", notificationsRouter());
  api.use("/reports", reportsRouter());
  app.use("/api", api);

  // A URL the API doesn't have (distinct from "Not found." for a missing row, so tests can tell them apart).
  app.use((_req, res) => {
    res.status(404).json({ detail: UNKNOWN_ENDPOINT });
  });
  app.use(errorHandler);
  return app;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(err.body);
    return;
  }
  if (err instanceof multer.MulterError) {
    const max = Math.floor(config.MAX_ATTACHMENT_SIZE / 1024 / 1024);
    const message = err.code === "LIMIT_FILE_SIZE" ? `File too large (max ${max} MB).` : err.message;
    res.status(400).json({ file: [message] });
    return;
  }
  if ((err as { type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ detail: `JSON parse error - ${(err as Error).message}` });
    return;
  }
  if ((err as { type?: string }).type === "entity.too.large") {
    res.status(413).json({ detail: "Request body too large." });
    return;
  }
  logger.error({ err, url: req.originalUrl }, "unhandled error");
  res.status(500).json({ detail: "Something went wrong on the server." });
};
