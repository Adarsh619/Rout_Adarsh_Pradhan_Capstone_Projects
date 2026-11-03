import type { Express } from "express";
import type { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectMongo } from "../../src/lib/mongo.js";
import { hashPassword } from "../../src/modules/auth/password.js";
import { User } from "../../src/modules/users/user.model.js";
import { PASSWORD, refreshCookie, register, startTestServices, wipe, withCsrf } from "./helpers.js";

let app: Express;
let redis: Redis;

beforeAll(async () => {
  ({ app, redis } = await startTestServices());
  await User.init(); // make sure the unique email index exists
});

beforeEach(async () => {
  await wipe(redis);
});

afterAll(async () => {
  await wipe(redis);
  await Promise.allSettled([disconnectMongo(), redis.quit()]);
});

const api = () => request(app);
const login = (email: string, password = PASSWORD) => api().post("/api/v1/auth/login").send({ email, password });
const refresh = (cookie: string) => api().post("/api/v1/auth/refresh").set(withCsrf).set("Cookie", cookie);

describe("register", () => {
  it("creates a customer, signs them in and never returns the password hash", async () => {
    const { res, cookie } = await register(app, { email: "Priya@Example.com" });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ name: "Test User", email: "priya@example.com", role: "customer", status: "active" });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.expiresIn).toBe(900);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
    expect(cookie).toMatch(/^ss_refresh=/);

    const stored = await User.findOne({ email: "priya@example.com" }).select("+passwordHash");
    expect(stored!.passwordHash).not.toBe(PASSWORD);
  });

  it("sets the refresh cookie httpOnly, scoped to the auth endpoints", async () => {
    const { res } = await register(app);
    const raw = ([] as string[]).concat(res.headers["set-cookie"] ?? []).join(";");
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/v1\/auth/);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it("can register a vendor but never an admin", async () => {
    expect((await register(app, { role: "vendor" })).res.body.user.role).toBe("vendor");
    const admin = await api()
      .post("/api/v1/auth/register")
      .send({ name: "Sneaky", email: "x@example.com", password: PASSWORD, role: "admin" });
    expect(admin.status).toBe(400);
    expect(admin.body.error.code).toBe("validation_error");
  });

  it("rejects a taken email in any letter case", async () => {
    await register(app, { email: "dup@example.com" });
    const { res } = await register(app, { email: "DUP@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("email_taken");
  });

  it("lists every invalid field", async () => {
    const res = await api().post("/api/v1/auth/register").send({ name: "A", email: "nope", password: "short" });
    expect(res.status).toBe(400);
    const fields = res.body.error.details.fields.map((f: { field: string }) => f.field).sort();
    expect(fields).toEqual(["email", "name", "password"]);
  });
});

describe("login", () => {
  beforeEach(async () => {
    await register(app, { email: "priya@example.com" });
  });

  it("signs in with any letter case in the email", async () => {
    const res = await login("PRIYA@example.com");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe("priya@example.com");
    expect(refreshCookie(res)).toMatch(/^ss_refresh=/);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const wrong = await login("priya@example.com", "Wrong-password-1");
    const unknown = await login("nobody@example.com");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
    expect(wrong.body.error.code).toBe("invalid_credentials");
  });

  it("locks an email for 15 minutes after 5 wrong passwords, even with the right one", async () => {
    for (let i = 0; i < 5; i++) expect((await login("priya@example.com", "Wrong-password-1")).status).toBe(401);
    const locked = await login("priya@example.com");
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("rate_limited");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("forgets earlier failures after a successful sign-in", async () => {
    for (let i = 0; i < 4; i++) await login("priya@example.com", "Wrong-password-1");
    expect((await login("priya@example.com")).status).toBe(200);
    for (let i = 0; i < 4; i++) await login("priya@example.com", "Wrong-password-1");
    expect((await login("priya@example.com")).status).toBe(200);
  });

  it("refuses suspended accounts, but only after the right password", async () => {
    await User.updateOne({ email: "priya@example.com" }, { status: "suspended" });
    expect((await login("priya@example.com", "Wrong-password-1")).body.error.code).toBe("invalid_credentials");
    const res = await login("priya@example.com");
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("account_suspended");
  });

  it("signs in seeded admins", async () => {
    await User.create({
      name: "Asha Admin",
      email: "admin@example.com",
      role: "admin",
      passwordHash: await hashPassword(PASSWORD, 4),
    });
    expect((await login("admin@example.com")).body.user.role).toBe("admin");
  });
});

describe("me, refresh and logout", () => {
  it("returns the signed-in user from the access token", async () => {
    const { accessToken } = await register(app, { name: "Priya" });
    const res = await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Priya");
  });

  it("rotates the refresh token on every use", async () => {
    const { cookie } = await register(app);
    const first = await refresh(cookie);
    expect(first.status).toBe(200);
    expect(first.body.accessToken).toEqual(expect.any(String));
    const next = refreshCookie(first);
    expect(next).not.toBe(cookie);
    expect((await refresh(next)).status).toBe(200);
  });

  it("treats a second refresh with the same token moments later as a race, not theft", async () => {
    const { cookie } = await register(app);
    expect((await refresh(cookie)).status).toBe(200);
    const again = await refresh(cookie);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("refresh_in_progress");
  });

  it("signs the user out everywhere when an old refresh token is reused later", async () => {
    const { cookie, accessToken } = await register(app);
    const other = await login("user@example.com");
    const rotated = refreshCookie(await refresh(cookie));
    // Pretend the rotation happened long ago, beyond the race grace period.
    const sid = cookie.split("=")[1]!.split(".")[0]!;
    await redis.hset(`session:${sid}`, "rotatedAt", Date.now() - 60_000);

    const reuse = await refresh(cookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe("session_reused");
    expect((await refresh(rotated)).status).toBe(401);
    expect((await refresh(refreshCookie(other))).status).toBe(401);
    expect((await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`)).status).toBe(401);
  });

  it("needs the X-Requested-With header to refresh or log out (CSRF protection)", async () => {
    const { cookie } = await register(app);
    const res = await api().post("/api/v1/auth/refresh").set("Cookie", cookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("csrf_header_missing");
  });

  it("answers 401 without a cookie or with a forged one", async () => {
    expect((await api().post("/api/v1/auth/refresh").set(withCsrf)).status).toBe(401);
    const { cookie } = await register(app);
    const forged = cookie.replace(/\.[^.]+$/, ".forged-secret");
    expect((await refresh(forged)).body.error.code).toBe("session_ended");
  });

  it("logout ends the session at once: the access token stops working and refresh fails", async () => {
    const { cookie, accessToken } = await register(app);
    const out = await api().post("/api/v1/auth/logout").set(withCsrf).set("Cookie", cookie);
    expect(out.status).toBe(204);
    expect(([] as string[]).concat(out.headers["set-cookie"] ?? []).join(";")).toMatch(/ss_refresh=;/);
    const me = await api().get("/api/v1/auth/me").set("Authorization", `Bearer ${accessToken}`);
    expect(me.status).toBe(401);
    expect(me.body.error.code).toBe("session_ended");
    expect((await refresh(cookie)).status).toBe(401);
  });

  it("stops a suspended user at the next refresh", async () => {
    const { cookie } = await register(app, { email: "s@example.com" });
    await User.updateOne({ email: "s@example.com" }, { status: "suspended" });
    expect((await refresh(cookie)).status).toBe(401);
  });
});

describe("account", () => {
  it("updates the name", async () => {
    const { accessToken } = await register(app);
    const res = await api()
      .patch("/api/v1/account")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ name: "  Priya Sharma  " });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe("Priya Sharma");
  });

  it("changes the password and signs out every other browser, keeping this one", async () => {
    const { accessToken, cookie } = await register(app, { email: "p@example.com" });
    const laptop = await login("p@example.com");

    const res = await api()
      .post("/api/v1/account/password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: PASSWORD, newPassword: "Brand-new-pass-2" });
    expect(res.status).toBe(200);
    expect(res.body.signedOutSessions).toBe(1);

    expect((await refresh(refreshCookie(laptop))).status).toBe(401);
    expect((await refresh(cookie)).status).toBe(200);
    expect((await login("p@example.com")).status).toBe(401);
    expect((await login("p@example.com", "Brand-new-pass-2")).status).toBe(200);
  });

  it("needs the right current password", async () => {
    const { accessToken } = await register(app);
    const res = await api()
      .post("/api/v1/account/password")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ currentPassword: "Not-my-pass-1", newPassword: "Brand-new-pass-2" });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fields[0]).toEqual({ field: "currentPassword", message: "Current password is incorrect" });
  });

  it("is only for signed-in users", async () => {
    expect((await api().patch("/api/v1/account").send({ name: "X Y" })).status).toBe(401);
  });
});
