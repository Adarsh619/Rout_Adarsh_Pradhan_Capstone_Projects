import path from "node:path";
import { z } from "zod";

// Every setting comes from the environment (see ../.env.example). Names match the v1 (Django) deployment where they
// mean the same thing, so the live site's Render settings keep working: DJANGO_SECRET_KEY is still read as a fallback.

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase())));
const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? fallback : Number.parseInt(v, 10)))
    .pipe(z.number().int().nonnegative());
const list = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) => (v ?? fallback).split(",").map((s) => s.trim()).filter(Boolean));

const schema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: int(8000),
  DATABASE_URL: z.string().default("postgresql://taskflow:taskflow@localhost:5432/taskflow"),
  REDIS_URL: z.string().default("redis://localhost:6379/0"),
  SECRET_KEY: z.string().optional(),
  DJANGO_SECRET_KEY: z.string().optional(),
  DEBUG: z.string().optional(),
  DJANGO_DEBUG: z.string().optional(),
  APP_VERSION: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),

  JWT_ACCESS_MINUTES: int(60),
  JWT_REFRESH_DAYS: int(7),
  API_RATE_LIMIT: z.string().default("2000/hour"),
  AUTH_RATE_LIMIT: z.string().default("10/minute"),
  // How many reverse proxies sit in front of the API: decides which X-Forwarded-For entry is the client.
  TRUSTED_PROXY_COUNT: int(0),
  CORS_ALLOWED_ORIGINS: list("http://localhost:5173,http://localhost:3000"),
  FRONTEND_URL: z.string().default("http://localhost:5173"),

  MEDIA_ROOT: z.string().default(path.resolve("media")),
  MAX_ATTACHMENT_SIZE: int(10 * 1024 * 1024),

  DEMO_MODE: bool(false),
  DEMO_VISITOR_RETENTION_DAYS: int(7),

  // Jobs run in the BullMQ worker; JOBS_INLINE=true runs them in the API process instead (tests, quick local dev).
  JOBS_INLINE: bool(false),
  // Run the BullMQ worker inside the API process (the live site's single container).
  EMBEDDED_WORKER: bool(false),
  WEBHOOK_ALLOW_PRIVATE_URLS: bool(false),
  WEBHOOK_DELIVERY_RETENTION_DAYS: int(30),

  // console (print to the worker log), json (kept in memory; tests) or an smtp:// URL.
  EMAIL_TRANSPORT: z.string().default("console"),
  DEFAULT_FROM_EMAIL: z.string().default("TaskFlow <noreply@taskflow.local>"),

  // STRIPE_MOCK=true: Stripe's official stripe-mock server + a simulated checkout page (no Stripe account needed).
  // STRIPE_MOCK=false: real Stripe *test mode* keys.
  STRIPE_MOCK: bool(false),
  STRIPE_API_BASE: z.string().default("http://localhost:12111"),
  STRIPE_SECRET_KEY: z.string().default(""),
  STRIPE_WEBHOOK_SECRET: z.string().default(""),
  STRIPE_PRICE_PRO: z.string().default(""),
  STRIPE_PRICE_BUSINESS: z.string().default(""),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = schema.parse(env);
  const debugFlag = e.DEBUG ?? e.DJANGO_DEBUG;
  const debug = debugFlag === undefined ? e.NODE_ENV !== "production" : ["1", "true", "yes", "on"].includes(debugFlag.toLowerCase());
  const secret = e.SECRET_KEY || e.DJANGO_SECRET_KEY || "";
  if (!secret && !debug) throw new Error("SECRET_KEY must be set when DEBUG is off.");
  const mock = e.STRIPE_MOCK;
  return {
    ...e,
    debug,
    secretKey: secret || "dev-insecure-secret-key-change-me",
    stripe: {
      mock,
      apiBase: e.STRIPE_API_BASE,
      secretKey: e.STRIPE_SECRET_KEY || (mock ? "sk_test_mock" : ""),
      webhookSecret: e.STRIPE_WEBHOOK_SECRET || (mock ? "whsec_mock_local" : ""),
      pricePro: e.STRIPE_PRICE_PRO || (mock ? "price_mock_pro" : ""),
      priceBusiness: e.STRIPE_PRICE_BUSINESS || (mock ? "price_mock_business" : ""),
    },
  };
}

// The settings for this process. Tests change fields on it directly (it is a plain object).
export const config = loadConfig();

// "10/minute" → { limit: 10, windowMs: 60000 } (the format the v1 settings used).
export function parseRate(rate: string): { limit: number; windowMs: number } {
  const [n, unit] = rate.split("/");
  const ms = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 }[(unit ?? "").replace(/s$/, "")];
  const limit = Number.parseInt(n ?? "", 10);
  if (!ms || !Number.isFinite(limit)) throw new Error(`Invalid rate "${rate}"; use e.g. 10/minute.`);
  return { limit, windowMs: ms };
}
