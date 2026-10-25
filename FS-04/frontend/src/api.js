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

export class ApiError extends Error {
  constructor(status, data) {
    super(formatError(data) || `Request failed (${status})`);
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

async function refreshAccess() {
  if (!store.refresh) return false;
  const r = await fetch(`${BASE}/api/auth/token/refresh/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh: store.refresh }),
  });
  if (!r.ok) { store.clear(); return false; }
  store.set(await r.json());
  return true;
}

export async function request(path, { method = "GET", body, raw = false, retry = true } = {}) {
  const headers = {};
  if (store.access) headers.Authorization = `Bearer ${store.access}`;
  if (currentWorkspace) headers["X-Workspace"] = currentWorkspace;
  const isForm = body instanceof FormData;
  if (body && !isForm) headers["Content-Type"] = "application/json";
  const res = await fetch(`${BASE}/api${path}`, {
    method, headers, body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401 && retry && (await refreshAccess())) {
    return request(path, { method, body, raw, retry: false });
  }
  if (raw) return res;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
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
};

export async function download(path, filename) {
  const res = await request(path.replace(/^\/api/, ""), { raw: true });
  if (!res.ok) throw new ApiError(res.status, null);
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
