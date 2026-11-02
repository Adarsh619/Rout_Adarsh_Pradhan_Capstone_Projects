import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { AppError, errorHandler } from "../src/middleware/errors.js";

// A tiny app with routes that throw, to check every error comes back in the same JSON shape.
const app = express();
app.use(express.json({ limit: "10b" }));
app.get("/conflict", () => {
  throw new AppError(409, "out_of_stock", "Only 2 left", { available: 2 });
});
app.get("/crash", () => {
  throw new Error("database exploded");
});
app.post("/echo", (req, res) => {
  res.json(req.body);
});
app.use(errorHandler);

describe("errorHandler", () => {
  it("returns an AppError's status, code, message and details", async () => {
    const res = await request(app).get("/conflict");
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: { code: "out_of_stock", message: "Only 2 left", details: { available: 2 } } });
  });

  it("hides the details of unexpected errors", async () => {
    const res = await request(app).get("/crash");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: "internal_error", message: "Something went wrong" } });
    expect(JSON.stringify(res.body)).not.toContain("database");
  });

  it("answers an oversized body with 413", async () => {
    const res = await request(app).post("/echo").send({ text: "far more than ten bytes" });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("payload_too_large");
  });
});
