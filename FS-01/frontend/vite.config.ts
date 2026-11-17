import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // In development the API runs on :4000; the browser calls /api on the same origin and Vite forwards it.
    proxy: { "/api": "http://localhost:4000" },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    css: false,
    // Page tests type into forms with user-event, which is slow in jsdom when many files run in parallel (and on CI).
    testTimeout: 15_000,
    // `npm run test:coverage`: what the component tests exercise (entry point and test helpers left out).
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/test/**", "src/**/*.test.{ts,tsx}", "src/vite-env.d.ts"],
      reporter: ["text-summary", "json-summary"],
    },
  },
});
