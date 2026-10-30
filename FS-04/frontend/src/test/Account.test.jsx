import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Private } from "../App";
import { tokens } from "../api";
import { AuthProvider } from "../auth";
import Account from "../pages/Account";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const USER = { id: 1, email: "owner@acme.test", full_name: "Allison Hill", display_name: "Allison Hill" };

function renderAccount(handlers) {
  tokens.set({ access: "a1", refresh: "r1" });
  const fetch = vi.fn(async (url, opts = {}) => {
    for (const [pattern, handler] of Object.entries(handlers)) if (url.endsWith(pattern) && opts.method === "POST") return handler(opts);
    if (url.endsWith("/auth/me/") && opts.method === "PATCH") return json(200, { ...USER, ...JSON.parse(opts.body), display_name: JSON.parse(opts.body).full_name });
    return json(200, USER);
  });
  vi.stubGlobal("fetch", fetch);
  render(
    <MemoryRouter initialEntries={["/account"]}>
      <AuthProvider>
        <Routes><Route path="/account" element={<Private><Account /></Private>} /></Routes>
      </AuthProvider>
    </MemoryRouter>
  );
  return fetch;
}
const type = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("changes the password and keeps this session with the new tokens", async () => {
  const fetch = renderAccount({ "/auth/password/": () => json(200, { access: "a2", refresh: "r2" }) });
  await screen.findByRole("heading", { name: "Change password" });
  type("Current password", "demo12345");
  type("New password", "Brand-new-pass-42");
  type("Confirm new password", "Brand-new-pass-42");
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByRole("status")).toHaveTextContent("other devices have been signed out");
  const sent = fetch.mock.calls.find(([url]) => url.endsWith("/auth/password/"));
  expect(JSON.parse(sent[1].body)).toEqual({ current_password: "demo12345", new_password: "Brand-new-pass-42" });
  expect(tokens.refresh).toBe("r2");
  expect(screen.getByLabelText("Current password")).toHaveValue("");
});

it("shows the server's message next to the wrong field", async () => {
  renderAccount({ "/auth/password/": () => json(400, { current_password: ["Current password is incorrect."] }) });
  await screen.findByRole("heading", { name: "Change password" });
  type("Current password", "wrong");
  type("New password", "Brand-new-pass-42");
  type("Confirm new password", "Brand-new-pass-42");
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByText("Current password is incorrect.")).toBeInTheDocument();
  expect(screen.getByLabelText("Current password")).toHaveAttribute("aria-invalid", "true");
  expect(tokens.refresh).toBe("r1");
});

it("won't send when the new passwords don't match", async () => {
  const fetch = renderAccount({});
  await screen.findByRole("heading", { name: "Change password" });
  type("New password", "Brand-new-pass-42");
  type("Confirm new password", "Brand-new-pass-43");
  expect(screen.getByText("The passwords don't match.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Change password" })).toBeDisabled();
  expect(fetch.mock.calls.some(([url]) => url.endsWith("/auth/password/"))).toBe(false);
});

it("saves a new display name", async () => {
  renderAccount({});
  await screen.findByRole("heading", { name: "Profile" });
  expect(screen.getByRole("button", { name: "Save name" })).toBeDisabled(); // nothing changed yet
  type("Full name", "Allison H.");
  fireEvent.click(screen.getByRole("button", { name: "Save name" }));
  expect(await screen.findByText("Name saved.")).toBeInTheDocument();
});
