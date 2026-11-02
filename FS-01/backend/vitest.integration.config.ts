import { defineConfig } from "vitest/config";

// Integration tests talk to real MongoDB, Redis, Elasticsearch and S3.
// Start them first with `docker compose up -d mongo redis elasticsearch s3` (from FS-01/).
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
