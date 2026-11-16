import { execFileSync } from "node:child_process";
import pg from "pg";
import { loadEnv } from "../../src/config/env.js";

// The integration tests use their own database (shopsphere_test) on the same PostgreSQL server, so they never touch
// development data. Created on first use, then brought up to the current schema with the real migrations.
export const testDatabaseUrl = (base = loadEnv().DATABASE_URL) => {
  const url = new URL(base);
  url.pathname = "/shopsphere_test";
  return url.toString();
};

export default async function setup() {
  const url = new URL(testDatabaseUrl());
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", ["shopsphere_test"]);
  if (exists.rowCount === 0) await client.query("CREATE DATABASE shopsphere_test");
  await client.end();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
