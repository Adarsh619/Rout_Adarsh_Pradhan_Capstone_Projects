import { defineConfig } from "vitest/config";

// Every test (unit + integration) in one run, for the combined coverage report: `npm run test:coverage`.
// Needs the same services as the integration tests (`docker compose up -d postgres redis elasticsearch s3`).
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // Entry points and one-off scripts are exercised by the smoke test, not by Vitest; the Prisma client is generated.
      exclude: ["src/index.ts", "src/worker.ts", "src/scripts/**", "src/generated/**"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage-all",
    },
  },
});
