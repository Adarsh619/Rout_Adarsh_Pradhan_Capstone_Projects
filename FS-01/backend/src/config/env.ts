import { z } from "zod";

// Every setting comes from the environment and is checked once at start-up,
// so a missing or malformed value stops the process with a clear message instead of failing later.
const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  // Comma-separated list of browser origins allowed to call the API (the Vercel site in production).
  CORS_ORIGINS: z.string().default("http://localhost:3000,http://localhost:5173"),

  MONGO_URL: z.string().url().default("mongodb://localhost:27017/shopsphere?replicaSet=rs0&directConnection=true"),
  REDIS_URL: z.string().url().default("redis://localhost:6379/0"),
  ELASTICSEARCH_URL: z.string().url().default("http://localhost:9200"),
  // The alias searches go through; each rebuild creates a new index behind it and switches the alias.
  ES_INDEX: z.string().regex(/^[a-z0-9_-]+$/).default("products"),

  // Leave S3_ENDPOINT empty to use real AWS S3; set it to the local S3 mock in Docker.
  S3_ENDPOINT: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  S3_REGION: z.string().default("ap-south-1"),
  S3_BUCKET: z.string().min(3).default("shopsphere-local"),
  S3_ACCESS_KEY_ID: z.string().default("local"),
  S3_SECRET_ACCESS_KEY: z.string().default("local"),
  S3_FORCE_PATH_STYLE: bool.default(true),
  // Create the bucket on start-up if it is missing (local only; real buckets are created in AWS).
  S3_CREATE_BUCKET: bool.default(false),
  // Where the *browser* reaches storage, when that differs from S3_ENDPOINT (in Docker the API uses http://s3:9090
  // but the browser uses http://localhost:9090). Upload links are signed for this address. Empty = real AWS.
  S3_PUBLIC_ENDPOINT: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  // Base URL for showing product photos and store logos. Empty = worked out from the endpoint or the AWS bucket URL.
  S3_PUBLIC_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),

  PAYMENT_PROVIDER: z.enum(["mock", "razorpay"]).default("mock"),

  // Signs access tokens. Required (32+ characters) when NODE_ENV=production; a fixed value is used only in dev and tests.
  JWT_ACCESS_SECRET: z.string().min(32, "must be at least 32 characters").optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  // The live site runs the app and the API on different domains, which needs Secure + SameSite=None cookies.
  COOKIE_SECURE: bool.default(false),
  COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),
});

const DEV_JWT_SECRET = "dev-only-insecure-jwt-secret-change-me-0123456789";

export type Env = Omit<z.infer<typeof schema>, "JWT_ACCESS_SECRET"> & { JWT_ACCESS_SECRET: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema
    .superRefine((env, ctx) => {
      if (env.NODE_ENV === "production" && !env.JWT_ACCESS_SECRET) {
        ctx.addIssue({ code: "custom", path: ["JWT_ACCESS_SECRET"], message: "is required in production" });
      }
      if (env.COOKIE_SAME_SITE === "none" && !env.COOKIE_SECURE) {
        ctx.addIssue({ code: "custom", path: ["COOKIE_SECURE"], message: "must be true when COOKIE_SAME_SITE=none" });
      }
    })
    .transform((env) => ({ ...env, JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET ?? DEV_JWT_SECRET }))
    .safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}

export const corsOrigins = (env: Env): string[] =>
  env.CORS_ORIGINS.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
