import express from "express";
import { SignJWT } from "jose";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { requireAuth, requireRole } from "../src/middleware/auth.js";
import { errorHandler } from "../src/middleware/errors.js";
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from "../src/modules/auth/password.js";
import type { SessionStore } from "../src/modules/auth/sessions.js";
import { AccessTokens, hashSecret, parseRefreshToken } from "../src/modules/auth/tokens.js";

const SECRET = "unit-test-secret-that-is-long-enough-0123";

describe("password rules", () => {
  const check = (p: string) => passwordSchema.safeParse(p);

  it("accepts 10+ characters with a letter and a number", () => {
    expect(check("shopsphere1").success).toBe(true);
  });

  it.each([
    ["too short", "abc123"],
    ["no number", "onlyletters"],
    ["no letter", "1234567890"],
    ["over bcrypt's 72-byte limit", "a1".repeat(37)],
  ])("rejects a password that is %s", (_label, p) => {
    expect(check(p).success).toBe(false);
  });

  it("counts bytes, not characters, for the 72-byte limit", () => {
    // 36 × "é" (2 bytes each) = 72 bytes plus "1" = 73 bytes, though only 37 characters.
    expect(check("é".repeat(36) + "1").success).toBe(false);
  });

  it("hashes and verifies", async () => {
    const hash = await hashPassword("correct horse 1", 4);
    expect(hash).not.toContain("correct");
    expect(await verifyPassword("correct horse 1", hash)).toBe(true);
    expect(await verifyPassword("wrong horse 1", hash)).toBe(false);
    await expect(burnPasswordCheck("anything 1", 4)).resolves.toBeUndefined();
  });
});

describe("access tokens", () => {
  const tokens = new AccessTokens(SECRET, 900);

  it("round-trips the user, role and session", async () => {
    const t = await tokens.sign({ sub: "u1", role: "vendor", sid: "s1" });
    expect(await tokens.verify(t)).toEqual({ sub: "u1", role: "vendor", sid: "s1" });
  });

  it("reports expired tokens separately so the client knows to refresh", async () => {
    const old = await new SignJWT({ role: "customer", sid: "s1" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u1")
      .setIssuer("shopsphere")
      .setAudience("shopsphere-web")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await tokens.verify(old)).toBe("expired");
  });

  it("rejects tokens signed with another key, tampered or malformed", async () => {
    const other = await new AccessTokens("another-secret-that-is-long-enough-xyz", 900).sign({
      sub: "u1",
      role: "admin",
      sid: "s1",
    });
    expect(await tokens.verify(other)).toBe("invalid");
    const good = await tokens.sign({ sub: "u1", role: "customer", sid: "s1" });
    const [h, , s] = good.split(".");
    const forgedPayload = Buffer.from(JSON.stringify({ sub: "u1", role: "admin", sid: "s1" })).toString("base64url");
    expect(await tokens.verify(`${h}.${forgedPayload}.${s}`)).toBe("invalid");
    expect(await tokens.verify("not-a-jwt")).toBe("invalid");
  });

  it("refuses the unsigned 'none' algorithm", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({ sub: "u1", role: "admin", sid: "s1", iss: "shopsphere", aud: "shopsphere-web" }),
    ).toString("base64url");
    expect(await tokens.verify(`${header}.${payload}.`)).toBe("invalid");
  });
});

describe("refresh token format", () => {
  it("splits session id and secret", () => {
    expect(parseRefreshToken("abc.def")).toEqual({ sid: "abc", secret: "def" });
  });

  it.each([undefined, "", "nodot", "a.b.c", ".x", "x.", `${"s".repeat(65)}.x`])("rejects %j", (t) => {
    expect(parseRefreshToken(t)).toBeUndefined();
  });

  it("stores only a hash of the secret", () => {
    expect(hashSecret("secret")).not.toContain("secret");
    expect(hashSecret("secret")).toBe(hashSecret("secret"));
  });
});

describe("requireAuth and requireRole", () => {
  const tokens = new AccessTokens(SECRET, 900);
  const sessions = (active: boolean) => ({ isActive: async () => active }) as unknown as SessionStore;

  const appWith = (active: boolean) => {
    const app = express();
    app.get("/vendor-only", requireAuth(tokens, sessions(active)), requireRole("vendor", "admin"), (req, res) => {
      res.json(req.auth);
    });
    app.use(errorHandler);
    return app;
  };

  const bearer = async (role: "customer" | "vendor" | "admin") =>
    `Bearer ${await tokens.sign({ sub: "u1", role, sid: "s1" })}`;

  it("lets an allowed role through and exposes who it is", async () => {
    const res = await request(appWith(true)).get("/vendor-only").set("Authorization", await bearer("vendor"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: "u1", role: "vendor", sid: "s1" });
  });

  it("answers 401 without a token", async () => {
    const res = await request(appWith(true)).get("/vendor-only");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthenticated");
  });

  it("answers 401 session_ended when the session was revoked", async () => {
    const res = await request(appWith(false)).get("/vendor-only").set("Authorization", await bearer("vendor"));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("session_ended");
  });

  it("answers 403 with the allowed roles for the wrong role", async () => {
    const res = await request(appWith(true)).get("/vendor-only").set("Authorization", await bearer("customer"));
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: "forbidden", details: { requiredRoles: ["vendor", "admin"] } });
  });
});

describe("auth settings", () => {
  it("requires a real JWT secret in production", () => {
    expect(() => loadEnv({ NODE_ENV: "production" })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => loadEnv({ NODE_ENV: "production", JWT_ACCESS_SECRET: "short" })).toThrow(/32 characters/);
    expect(loadEnv({ NODE_ENV: "production", JWT_ACCESS_SECRET: "x".repeat(32) }).JWT_ACCESS_SECRET).toHaveLength(32);
  });

  it("uses a development secret outside production", () => {
    expect(loadEnv({}).JWT_ACCESS_SECRET.length).toBeGreaterThanOrEqual(32);
  });

  it("refuses SameSite=None cookies without Secure", () => {
    expect(() => loadEnv({ COOKIE_SAME_SITE: "none" })).toThrow(/COOKIE_SECURE/);
    expect(loadEnv({ COOKIE_SAME_SITE: "none", COOKIE_SECURE: "true" }).COOKIE_SECURE).toBe(true);
  });
});
