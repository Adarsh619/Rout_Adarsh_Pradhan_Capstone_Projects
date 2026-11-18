import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { config } from "../src/config.js";
import { connectDb, prisma } from "../src/lib/db.js";
import { outbox } from "../src/lib/mail.js";
import { testing } from "../src/jobs/queue.js";
import { http } from "../src/modules/integrations/jobs.js";
import { dns } from "../src/modules/integrations/urlsafety.js";
import { testDatabaseUrl } from "./global-setup.js";

// Runs before every test file: one database connection, clean tables before each test, jobs run inline, emails
// kept in memory, attachments in a temporary folder, and no real DNS or HTTP for webhooks.

const defaults = { ...config, stripe: { ...config.stripe } };
const realPost = http.post;
let media: string;

beforeAll(async () => {
  await connectDb(testDatabaseUrl(), { countQueries: true });
  media = mkdtempSync(path.join(tmpdir(), "taskflow-media-"));
});

beforeEach(async () => {
  Object.assign(config, defaults, {
    JOBS_INLINE: true,
    EMAIL_TRANSPORT: "json",
    MEDIA_ROOT: media,
    DEMO_MODE: false,
    AUTH_RATE_LIMIT: "1000/minute",
    API_RATE_LIMIT: "100000/hour",
    TRUSTED_PROXY_COUNT: 0,
    WEBHOOK_ALLOW_PRIVATE_URLS: false,
    MAX_ATTACHMENT_SIZE: 10 * 1024 * 1024,
    debug: true,
  });
  config.stripe = {
    ...defaults.stripe,
    mock: true,
    apiBase: process.env.STRIPE_API_BASE ?? "http://localhost:12111",
    secretKey: "sk_test_mock",
    webhookSecret: "whsec_mock_local",
    pricePro: "price_mock_pro",
    priceBusiness: "price_mock_business",
  };
  outbox.length = 0;
  testing.held = null;
  // Every host resolves to a public documentation address unless a test says otherwise.
  dns.resolve = async () => ["93.184.215.14"];
  // Webhook receivers answer 200 unless a test says otherwise.
  http.post = async () => new Response("ok", { status: 200 });
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`);
});

afterEach(() => {
  http.post = realPost;
});

afterAll(async () => {
  await prisma.$disconnect();
  rmSync(media, { recursive: true, force: true });
});
