import { api, ApiError, formatError, SESSION_EXPIRED, tokens } from "../api";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("formats DRF error payloads", () => {
  expect(formatError({ detail: "Nope" })).toBe("Nope");
  expect(formatError({ title: ["This field is required."] })).toBe("title: This field is required.");
  expect(formatError({ non_field_errors: ["Bad"] })).toBe("Bad");
});

it("turns a proxy's HTML error page into a readable message", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><h1>502 Bad Gateway</h1></html>", { status: 502 })));
  const err = await api.get("/projects/").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(502);
  expect(err.message).toMatch(/temporarily unavailable/);
});

it("reports an unreachable server instead of throwing a raw TypeError", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  const err = await api.get("/projects/").catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(0);
  expect(err.message).toMatch(/Can't reach the server/);
});

it("refreshes an expired access token once for parallel requests, then retries them", async () => {
  tokens.set({ access: "old", refresh: "r1" });
  const fetch = vi.fn(async (url, opts) => {
    if (url.endsWith("/auth/token/refresh/")) return json(200, { access: "new", refresh: "r2" });
    return opts.headers.Authorization === "Bearer new" ? json(200, { ok: true }) : json(401, { detail: "expired" });
  });
  vi.stubGlobal("fetch", fetch);
  const results = await Promise.all([api.get("/a/"), api.get("/b/")]);
  expect(results).toEqual([{ ok: true }, { ok: true }]);
  expect(fetch.mock.calls.filter(([url]) => url.endsWith("/refresh/"))).toHaveLength(1);
  expect(tokens.refresh).toBe("r2");
});

it("signs out and announces it when the session can't be renewed", async () => {
  tokens.set({ access: "old", refresh: "revoked" });
  vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "Token is invalid or expired" })));
  const expired = vi.fn();
  window.addEventListener(SESSION_EXPIRED, expired);
  await expect(api.get("/projects/")).rejects.toMatchObject({ status: 401 });
  window.removeEventListener(SESSION_EXPIRED, expired);
  expect(expired).toHaveBeenCalledTimes(1);
  expect(tokens.access).toBeNull();
  expect(tokens.refresh).toBeNull();
});

it("doesn't treat a wrong password as an expired session", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => json(401, { detail: "No active account found with the given credentials" })));
  const expired = vi.fn();
  window.addEventListener(SESSION_EXPIRED, expired);
  await expect(api.post("/auth/token/", { email: "a@b.c", password: "x" })).rejects.toMatchObject({ status: 401 });
  window.removeEventListener(SESSION_EXPIRED, expired);
  expect(expired).not.toHaveBeenCalled();
});
