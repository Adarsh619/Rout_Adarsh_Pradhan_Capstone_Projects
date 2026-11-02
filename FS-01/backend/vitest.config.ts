import { defineConfig } from "vitest/config";

// Unit tests: no databases needed, run anywhere with `npm test`.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/integration/**"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/worker.ts"],
      reporter: ["text", "lcov", "json-summary"],
    },
  },
});
