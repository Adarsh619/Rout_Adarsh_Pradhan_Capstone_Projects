import request from "supertest";
import { describe, expect, it } from "vitest";
import { unitApp } from "./helpers/app.js";

const app = unitApp();

describe("app basics", () => {
  it("answers unknown routes with a JSON 404", async () => {
    const res = await request(app).get("/api/v1/nope");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: "not_found", message: "No route for GET /api/v1/nope" } });
  });

  it("sends security headers and hides the framework", async () => {
    const res = await request(app).get("/api/v1/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows the configured origin and nobody else", async () => {
    const allowed = await request(app).get("/api/v1/health").set("Origin", "http://localhost:3000");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    const other = await request(app).get("/api/v1/health").set("Origin", "https://evil.example");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects malformed JSON with a 400", async () => {
    const res = await request(app).post("/api/v1/health").set("Content-Type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_json");
  });
});
