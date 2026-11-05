import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { setAccessToken } from "../api/client";
import { AuthProvider } from "../auth/AuthContext";
import type { User } from "../auth/types";

// Renders a component with the same providers the app uses, starting at the given URL.
export function renderWithProviders(ui: ReactElement, { route = "/" } = {}) {
  setAccessToken(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>{ui}</AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const errorResponse = (status: number, code: string, message = code, details?: unknown) =>
  jsonResponse({ error: { code, message, ...(details ? { details } : {}) } }, status);

type Handler = (init: RequestInit & { url: string }) => Response | Promise<Response>;

// Fakes the API: "METHOD /path" → handler. Unlisted calls fail loudly. Returns the fetch spy to inspect calls.
// By default nobody is signed in (the page-load refresh answers 401), the catalogue is empty and a vendor has no store.
export function mockApi(routes: Record<string, Handler>) {
  const all: Record<string, Handler> = {
    "POST /api/v1/auth/refresh": () => errorResponse(401, "session_ended"),
    // Data most pages load in the background; tests that care override these.
    "GET /api/v1/categories": () => jsonResponse({ items: [] }),
    "GET /api/v1/products": () => jsonResponse({ items: [], page: 1, limit: 24, total: 0 }),
    "GET /api/v1/vendors/me": () => jsonResponse({ store: null }),
    "GET /api/v1/cart": () => jsonResponse({ cart: { groups: [], itemCount: 0, itemsTotal: 0, problems: 0, canCheckout: false } }),
    ...routes,
  };
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(url, "http://localhost").pathname;
    const key = `${(init.method ?? "GET").toUpperCase()} ${path}`;
    const handler = all[key];
    if (!handler) throw new Error(`Unexpected API call: ${key}`);
    return handler({ ...init, url });
  });
}

export const makeUser = (overrides: Partial<User> = {}): User => ({
  id: "u1",
  name: "Priya Customer",
  email: "customer@shopsphere.test",
  role: "customer",
  status: "active",
  createdAt: "2026-11-01T10:00:00.000Z",
  ...overrides,
});

export const session = (user: User) => jsonResponse({ user, accessToken: `token-${user.role}`, expiresIn: 900 });
