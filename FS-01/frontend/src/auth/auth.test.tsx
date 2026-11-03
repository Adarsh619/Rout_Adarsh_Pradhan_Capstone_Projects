import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { safeNext } from "../pages/LoginPage";
import { errorResponse, jsonResponse, makeUser, mockApi, renderWithProviders, session } from "../test/render";

const healthOk = () => jsonResponse({ status: "ok", services: {}, version: "dev", time: "" });

describe("signing in", () => {
  it.each([
    ["customer", "My account", /your account/i],
    ["vendor", "Dashboard", /seller dashboard/i],
    ["admin", "Dashboard", /admin dashboard/i],
  ] as const)("takes a %s to their own page", async (role, navLabel, heading) => {
    const user = makeUser({ role, email: `${role}@shopsphere.test` });
    const fetchSpy = mockApi({ "POST /api/v1/auth/login": () => session(user) });
    renderWithProviders(<App />, { route: "/login" });

    await userEvent.type(await screen.findByLabelText("Email"), `${role}@shopsphere.test`);
    await userEvent.type(screen.getByLabelText("Password"), "Sh0pSphere-demo");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: navLabel })).toBeInTheDocument();
    const loginCall = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/auth/login"))!;
    expect(JSON.parse(loginCall[1]!.body as string)).toEqual({ email: `${role}@shopsphere.test`, password: "Sh0pSphere-demo" });
  });

  it("shows the server's message on a wrong password and stays on the page", async () => {
    mockApi({ "POST /api/v1/auth/login": () => errorResponse(401, "invalid_credentials", "Email or password is incorrect") });
    renderWithProviders(<App />, { route: "/login" });

    await userEvent.type(await screen.findByLabelText("Email"), "x@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Email or password is incorrect");
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("returns to the page the visitor wanted after signing in", async () => {
    mockApi({ "POST /api/v1/auth/login": () => session(makeUser({ role: "vendor" })) });
    renderWithProviders(<App />, { route: "/vendor" });

    // Redirected to sign-in first.
    await userEvent.type(await screen.findByLabelText("Email"), "vendor@shopsphere.test");
    await userEvent.type(screen.getByLabelText("Password"), "Sh0pSphere-demo");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: /seller dashboard/i })).toBeInTheDocument();
  });

  it("only follows ?next= links inside the site", () => {
    expect(safeNext("/vendor")).toBe("/vendor");
    expect(safeNext("//evil.example")).toBeUndefined();
    expect(safeNext("https://evil.example")).toBeUndefined();
    expect(safeNext(null)).toBeUndefined();
  });
});

describe("staying signed in", () => {
  it("restores the session from the refresh cookie on page load", async () => {
    mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser({ name: "Priya Sharma" })),
      "GET /api/v1/health": healthOk,
    });
    renderWithProviders(<App />, { route: "/account" });
    expect(await screen.findByRole("heading", { name: /your account/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Full name")).toHaveValue("Priya Sharma");
  });

  it("refreshes an expired access token and retries the request once", async () => {
    let patches = 0;
    const fetchSpy = mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser()),
      "PATCH /api/v1/account": () =>
        ++patches === 1
          ? errorResponse(401, "token_expired")
          : jsonResponse({ user: makeUser({ name: "Priya Sharma" }) }),
    });
    renderWithProviders(<App />, { route: "/account" });

    const name = await screen.findByLabelText("Full name");
    await userEvent.clear(name);
    await userEvent.type(name, "Priya Sharma");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Your name has been updated.")).toBeInTheDocument();
    const refreshes = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/auth/refresh"));
    expect(refreshes).toHaveLength(2); // page load + after the expired token
  });

  it("signs out and returns home", async () => {
    mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser()),
      "POST /api/v1/auth/logout": () => new Response(null, { status: 204 }),
      "GET /api/v1/health": healthOk,
    });
    renderWithProviders(<App />, { route: "/account" });
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("link", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /many sellers/i })).toBeInTheDocument();
  });
});

describe("role-protected pages", () => {
  it("sends visitors to sign-in", async () => {
    mockApi({});
    renderWithProviders(<App />, { route: "/admin" });
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("explains when the page is for another account type", async () => {
    mockApi({ "POST /api/v1/auth/refresh": () => session(makeUser({ role: "customer" })) });
    renderWithProviders(<App />, { route: "/admin" });
    expect(await screen.findByRole("heading", { name: /this page isn't for your account/i })).toBeInTheDocument();
    expect(screen.getByText(/it's for admin accounts/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to your dashboard/i })).toHaveAttribute("href", "/account");
  });
});

describe("register", () => {
  it("creates a seller account and opens the seller dashboard", async () => {
    const fetchSpy = mockApi({ "POST /api/v1/auth/register": () => session(makeUser({ role: "vendor", name: "Ravi" })) });
    renderWithProviders(<App />, { route: "/register" });

    await userEvent.click(await screen.findByText("I want to sell"));
    await userEvent.type(screen.getByLabelText("Full name"), "Ravi");
    await userEvent.type(screen.getByLabelText("Email"), "ravi@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "Sh0pSphere-demo");
    await userEvent.click(screen.getByRole("button", { name: "Create seller account" }));

    expect(await screen.findByRole("heading", { name: /seller dashboard/i })).toBeInTheDocument();
    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/auth/register"))!;
    expect(JSON.parse(call[1]!.body as string)).toMatchObject({ role: "vendor", email: "ravi@example.com" });
  });

  it("shows each field's error next to it", async () => {
    mockApi({
      "POST /api/v1/auth/register": () =>
        errorResponse(400, "validation_error", "Some fields need fixing", {
          fields: [
            { field: "email", message: "An account with this email already exists" },
            { field: "password", message: "Use at least 10 characters" },
          ],
        }),
    });
    renderWithProviders(<App />, { route: "/register" });
    await userEvent.type(await screen.findByLabelText("Full name"), "Priya");
    await userEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("An account with this email already exists")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Use at least 10 characters")).toBeInTheDocument();
  });
});

describe("account page", () => {
  it("tells the user how many other devices were signed out after a password change", async () => {
    mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser()),
      "POST /api/v1/account/password": () => jsonResponse({ ok: true, signedOutSessions: 2 }),
    });
    renderWithProviders(<App />, { route: "/account" });

    await userEvent.type(await screen.findByLabelText("Current password"), "Old-password-1");
    await userEvent.type(screen.getByLabelText("New password"), "New-password-2");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));

    expect(await screen.findByText(/2 other devices were signed out/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("New password")).toHaveValue(""));
  });
});
