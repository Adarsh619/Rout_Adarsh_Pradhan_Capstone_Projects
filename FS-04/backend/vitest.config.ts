import { defineConfig } from "vitest/config";

// API tests run against a real PostgreSQL (own database `<name>_test`), Redis and stripe-mock:
//   docker compose up -d db redis stripe-mock   (from FS-04/)
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/worker.ts", "src/jobs/worker.ts", "src/generated/**", "src/scripts/**"],
      reporter: ["text-summary", "lcov", "json-summary", "cobertura"],
      thresholds: { lines: 90, statements: 90 },
    },
  },
});
