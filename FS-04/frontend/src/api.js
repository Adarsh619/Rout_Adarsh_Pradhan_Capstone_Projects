// Small fetch wrapper: JWT auth, automatic token refresh, and the X-Workspace tenant header.
const BASE = import.meta.env.VITE_API_URL || "";
const store = {
  get access() { return localStorage.getItem("access"); },
  get refresh() { return localStorage.getItem("refresh"); },
  set(tokens) {
    if (tokens.access) localStorage.setItem("access", tokens.access);
    if (tokens.refresh) localStorage.setItem("refresh", tokens.refresh);
  },
  clear() { localStorage.removeItem("access"); localStorage.removeItem("refresh"); },
};

let currentWorkspace = null;
export const setWorkspace = (slug) => { currentWorkspace = slug; };
export const tokens = store;

// Fired when the session can't be renewed; AuthProvider listens and sends the user to the login page.
export const SESSION_EXPIRED = "taskflow:session-expired";

const OFFLINE = "Can't reach the server. Check your connection and try again.";
const UNAVAILABLE = "The server is temporarily unavailable. Please try again in a moment.";

export class ApiError extends Error {
  constructor(status, data) {
    super(formatError(data) || fallbackMessage(status));
    this.status = status;
    this.data = data;
  }
}

export function formatError(data) {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (data.detail) return data.detail;
  return Object.entries(data)
    .map(([k, v]) => `${k === "non_field_errors" ? "" : k + ": "}${Array.isArray(v) ? v.join(" ") : v}`)
    .join("; ");
}

function fallbackMessage(status) {
  if (status === 0) return OFFLINE;
  if (status >= 502 && status <= 504) return UNAVAILABLE;
  if (status >= 500) return "Something went wrong on the server. Please try again.";
  return `Request failed (${status})`;
}

// fetch() only rejects when the server can't be reached; turn that into an ApiError with status 0.
async function send(url, options) {
  try { return await fetch(url, options); } catch { throw new ApiError(0, null); }
}

// Error pages from a proxy (e.g. nginx's HTML 502) aren't JSON; keep the status and use a readable message.
async function readBody(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Refresh tokens rotate (the old one is blacklisted), so parallel 401s must share one refresh call.
let refreshing = null;
function refreshAccess() {
  refreshing ??= (async () => {
    if (!store.refresh) return false;
    const r = await send(`${BASE}/api/auth/token/refresh/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: store.refresh }),
    });
    if (!r.ok) { store.clear(); return false; }
    store.set(await r.json());
    return true;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function request(path, { method = "GET", body, raw = false, retry = true } = {}) {
  const headers = {};
  if (store.access) headers.Authorization = `Bearer ${store.access}`;
  if (currentWorkspace) headers["X-Workspace"] = currentWorkspace;
  const isForm = body instanceof FormData;
  if (body && !isForm) headers["Content-Type"] = "application/json";
  const res = await send(`${BASE}/api${path}`, {
    method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401 && retry && headers.Authorization) {
    if (await refreshAccess()) return request(path, { method, body, raw, retry: false });
    store.clear();
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  if (raw) return res;
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: "POST", body }),
  patch: (p, body) => request(p, { method: "PATCH", body }),
  del: (p) => request(p, { method: "DELETE" }),
  list: async (p) => {
    const d = await request(p);
    return Array.isArray(d) ? d : d?.results ?? [];
  },
  // Every page of a paginated list (lists return 100 rows per page), e.g. a project's whole backlog.
  all: async (p) => {
    const rows = [];
    for (;;) {
      const d = await request(`${p}${p.includes("?") ? "&" : "?"}limit=100&offset=${rows.length}`);
      if (Array.isArray(d)) return d;
      rows.push(...(d?.results ?? []));
      if (!d?.next || !d.results?.length) return rows;
    }
  },
};

export async function download(path, filename) {
  const res = await request(path.replace(/^\/api/, ""), { raw: true });
  if (!res.ok) throw new ApiError(res.status, null);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
