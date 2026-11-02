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

  // Leave S3_ENDPOINT empty to use real AWS S3; set it to the local S3 mock in Docker.
  S3_ENDPOINT: z.string().url().optional().or(z.literal("").transform(() => undefined)),
  S3_REGION: z.string().default("ap-south-1"),
  S3_BUCKET: z.string().min(3).default("shopsphere-local"),
  S3_ACCESS_KEY_ID: z.string().default("local"),
  S3_SECRET_ACCESS_KEY: z.string().default("local"),
  S3_FORCE_PATH_STYLE: bool.default(true),
  // Create the bucket on start-up if it is missing (local only; real buckets are created in AWS).
  S3_CREATE_BUCKET: bool.default(false),

  PAYMENT_PROVIDER: z.enum(["mock", "razorpay"]).default("mock"),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
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
