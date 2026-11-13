import { describe, expect, it } from "vitest";
import { corsOrigins, loadEnv } from "../src/config/env.js";
import { s3Credentials } from "../src/lib/s3.js";

describe("loadEnv", () => {
  it("fills in local defaults", () => {
    const env = loadEnv({});
    expect(env.PORT).toBe(4000);
    expect(env.PAYMENT_PROVIDER).toBe("mock");
    expect(env.S3_ENDPOINT).toBeUndefined();
    expect(env.S3_CREATE_BUCKET).toBe(false);
  });

  it("parses booleans and treats an empty S3 endpoint as real AWS", () => {
    const env = loadEnv({ S3_CREATE_BUCKET: "true", S3_FORCE_PATH_STYLE: "0", S3_ENDPOINT: "" });
    expect(env.S3_CREATE_BUCKET).toBe(true);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(env.S3_ENDPOINT).toBeUndefined();
  });

  it("picks S3 credentials: given keys, the mock's dummy keys, or the instance role", () => {
    const keys = { S3_ACCESS_KEY_ID: "AKIATEST", S3_SECRET_ACCESS_KEY: "secret" };
    expect(s3Credentials(loadEnv(keys))).toEqual({ credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret" } });
    expect(s3Credentials(loadEnv({ S3_ENDPOINT: "http://s3:9090" }))).toEqual({
      credentials: { accessKeyId: "local", secretAccessKey: "local" },
    });
    // Real AWS without keys: no credentials object, so the SDK's default chain (EC2 role) is used.
    expect(s3Credentials(loadEnv({ S3_ACCESS_KEY_ID: "", S3_SECRET_ACCESS_KEY: "" }))).toEqual({});
  });

  it("stops with a readable message on bad values", () => {
    expect(() => loadEnv({ PORT: "abc", PAYMENT_PROVIDER: "paypal" })).toThrow(/PORT[\s\S]*PAYMENT_PROVIDER/);
  });

  it("splits and trims CORS origins", () => {
    expect(corsOrigins(loadEnv({ CORS_ORIGINS: " https://a.app , https://b.app ," }))).toEqual([
      "https://a.app",
      "https://b.app",
    ]);
  });
});
