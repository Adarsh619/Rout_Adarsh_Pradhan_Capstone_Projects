import { execSync } from "node:child_process";
import pg from "pg";

// Tests use their own database (<name>_test next to the dev one), created if needed and migrated once per run.
export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL ?? "postgresql://taskflow:taskflow@localhost:5432/taskflow");
  if (!url.pathname.endsWith("_test")) url.pathname += "_test";
  return url.toString();
}

export default async function setup() {
  const url = testDatabaseUrl();
  const admin = new URL(url);
  const name = admin.pathname.slice(1);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
  if (!exists.rowCount) await client.query(`CREATE DATABASE "${name}"`);
  await client.end();
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  process.env.TEST_DATABASE_URL = url;
}
