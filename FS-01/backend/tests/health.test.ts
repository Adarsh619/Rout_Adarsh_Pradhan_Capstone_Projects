import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { runHealthChecks } from "../src/lib/health.js";

const up = async () => {};
const down = async () => {
  throw new Error("connection refused");
};
const hang = () => new Promise<void>(() => {});

const appWith = (checks: Record<string, () => Promise<void>>) =>
  createApp({ corsOrigins: ["http://localhost:3000"], healthChecks: checks });

describe("runHealthChecks", () => {
  it("reports ok when every service is up", async () => {
    expect(await runHealthChecks({ mongo: up, redis: up })).toEqual({
      status: "ok",
      services: { mongo: "up", redis: "up" },
    });
  });

  it("marks only the failing service as down", async () => {
    const report = await runHealthChecks({ mongo: up, redis: down });
    expect(report.status).toBe("degraded");
    expect(report.services).toEqual({ mongo: "up", redis: "down" });
  });

  it("treats a service that never answers as down after the timeout", async () => {
    const report = await runHealthChecks({ elasticsearch: hang, s3: up }, 50);
    expect(report.services).toEqual({ elasticsearch: "down", s3: "up" });
  });
});

describe("GET /api/v1/health", () => {
  it("returns 200 with service statuses when healthy", async () => {
    const res = await request(appWith({ mongo: up, redis: up })).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", services: { mongo: "up", redis: "up" } });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns 503 when a service is down", async () => {
    const res = await request(appWith({ mongo: up, redis: down })).get("/api/v1/health");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("degraded");
  });
});
