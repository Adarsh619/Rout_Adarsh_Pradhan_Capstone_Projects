import { describe, expect, it } from "vitest";
import { ApiError, shouldRetry } from "./client";

describe("shouldRetry", () => {
  it("never retries an answer the server already gave (4xx)", () => {
    for (const status of [400, 401, 403, 404, 409, 429]) expect(shouldRetry(0, new ApiError(status, "x", "x"))).toBe(false);
  });

  it("retries server and network errors up to 3 times", () => {
    expect(shouldRetry(0, new ApiError(503, "search_unavailable", "x"))).toBe(true);
    expect(shouldRetry(2, new TypeError("Failed to fetch"))).toBe(true);
    expect(shouldRetry(3, new TypeError("Failed to fetch"))).toBe(false);
  });
});
