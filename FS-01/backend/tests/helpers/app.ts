import { Redis } from "ioredis";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";

// An app for unit tests: real code, but Redis never connects unless a test actually uses it.
export function unitApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env: loadEnv({ NODE_ENV: "test" }),
    corsOrigins: ["http://localhost:3000"],
    redis: new Redis({ lazyConnect: true, maxRetriesPerRequest: 0 }),
    healthChecks: {},
    ...overrides,
  });
}
