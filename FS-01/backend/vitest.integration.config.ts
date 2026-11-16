import { defineConfig } from "vitest/config";

// Integration tests talk to real PostgreSQL, Redis, Elasticsearch and S3.
// Start them first with `docker compose up -d postgres redis elasticsearch s3` (from FS-01/).
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    // Creates the test database if needed and applies the migrations, once per run.
    globalSetup: ["tests/integration/global-setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
