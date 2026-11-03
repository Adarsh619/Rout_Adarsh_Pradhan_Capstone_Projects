// Locally the API is on the same origin (/api is proxied); on Vercel VITE_API_URL points at the API server.
const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  // Per-field messages from a 400 validation_error, keyed by field name.
  get fieldErrors(): Record<string, string> {
    const fields = (this.body as { error?: { details?: { fields?: { field: string; message: string }[] } } })?.error
      ?.details?.fields;
    return Object.fromEntries((fields ?? []).map((f) => [f.field, f.message]));
  }
}

// The access token lives only in memory (never localStorage), so injected scripts can't read it from storage.
// The refresh token is an httpOnly cookie the browser sends to /api/v1/auth by itself.
let accessToken: string | undefined;
export const setAccessToken = (token: string | undefined) => {
  accessToken = token;
};

// Called when the session is gone for good (refresh failed), so the app can show the sign-in page.
let onSessionEnded: (() => void) | undefined;
export const setSessionEndedHandler = (fn: (() => void) | undefined) => {
  onSessionEnded = fn;
};

async function send(path: string, init: RequestInit): Promise<Response> {
  return fetch(`${API_URL}/api/v1${path}`, {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      // Required by the API on cookie-based endpoints; other sites can't send it (CSRF protection).
      "X-Requested-With": "ShopSphere",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });
}

async function parse<T>(res: Response): Promise<T> {
  const body: unknown = res.headers.get("content-type")?.includes("application/json") ? await res.json() : undefined;
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, error?.code ?? "http_error", error?.message ?? `Request failed (${res.status})`, body);
  }
  return body as T;
}

export interface SessionResponse<U = unknown> {
  user: U;
  accessToken: string;
  expiresIn: number;
}

// Only one refresh at a time: every request that finds an expired token waits for the same one.
let refreshing: Promise<SessionResponse | undefined> | undefined;

export function refreshSession(): Promise<SessionResponse | undefined> {
  refreshing ??= (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const res = await send("/auth/refresh", { method: "POST" });
        // Another tab refreshed at the same moment; the browser now has the new cookie, so try again shortly.
        if (res.status === 409) {
          await new Promise((r) => setTimeout(r, 300));
          continue;
        }
        if (!res.ok) break;
        const session = await parse<SessionResponse>(res);
        setAccessToken(session.accessToken);
        return session;
      }
      setAccessToken(undefined);
      return undefined;
    } catch {
      // Network failure: keep the current state, the next request will try again.
      return undefined;
    } finally {
      refreshing = undefined;
    }
  })();
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 401 && accessToken) {
    const body = (await res.clone().json().catch(() => undefined)) as { error?: { code?: string } } | undefined;
    if (body?.error?.code === "token_expired") {
      if (await refreshSession()) return parse<T>(await send(path, init));
    }
    setAccessToken(undefined);
    onSessionEnded?.();
  }
  return parse<T>(res);
}
