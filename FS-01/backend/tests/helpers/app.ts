import { Redis } from "ioredis";
import { createApp, type AppDeps } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { createElasticsearch } from "../../src/lib/elasticsearch.js";
import { noReservations } from "../../src/modules/orders/reservations.js";
import { createPaymentProvider } from "../../src/modules/payments/payment-provider.js";
import { noSearchSync } from "../../src/modules/search/search-sync.js";
import { memoryStorage } from "./memory-storage.js";

// An app for unit tests: real code, but Redis never connects unless a test actually uses it.
export function unitApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env: loadEnv({ NODE_ENV: "test" }),
    corsOrigins: ["http://localhost:3000"],
    redis: new Redis({ lazyConnect: true, maxRetriesPerRequest: 0 }),
    storage: memoryStorage(),
    // Never contacted unless a test searches.
    es: createElasticsearch("http://localhost:9200"),
    searchSync: noSearchSync,
    payments: createPaymentProvider("mock", "unit-test-secret"),
    reservations: noReservations,
    healthChecks: {},
    ...overrides,
  });
}
