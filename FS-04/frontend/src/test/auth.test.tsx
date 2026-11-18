import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Private } from "../App";
import { SESSION_EXPIRED, tokens } from "../api";
import { AuthProvider } from "../auth";
import Login from "../pages/Login";
import NotFound from "../pages/NotFound";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const USER = { id: 1, email: "owner@acme.test", display_name: "Owner" };

function renderApp(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Private><p>Workspace list</p></Private>} />
          <Route path="/w/acme/members" element={<Private><p>Members page</p></Private>} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("returns you to the page you asked for after signing in", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => (
    url.endsWith("/auth/token/") ? json(200, { access: "a", refresh: "r" }) : json(200, USER)
  )));
  renderApp("/w/acme/members");
  expect(await screen.findByText("Sign in to your workspace")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@acme.test" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "demo12345" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("Members page")).toBeInTheDocument();
});

it("disables the button while signing in and shows the error", async () => {
  let reject;
  vi.stubGlobal("fetch", vi.fn(() => new Promise((_, r) => { reject = r; })));
  renderApp("/login");
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "x@y.z" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByRole("button", { name: "Signing in…" })).toBeDisabled();
  await act(async () => reject(new TypeError("Failed to fetch")));
  expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach the server");
  expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
});

it("sends you to sign in with a notice when the session expires", async () => {
  tokens.set({ access: "a", refresh: "r" });
  vi.stubGlobal("fetch", vi.fn(async () => json(200, USER)));
  renderApp("/");
  expect(await screen.findByText("Workspace list")).toBeInTheDocument();
  act(() => { window.dispatchEvent(new Event(SESSION_EXPIRED)); });
  expect(await screen.findByText(/Your session has expired/)).toBeInTheDocument();
});

it("keeps you signed in and offers a retry when the server is down at start-up", async () => {
  tokens.set({ access: "a", refresh: "r" });
  const fetch = vi.fn(async () => new Response("Bad Gateway", { status: 502 }));
  vi.stubGlobal("fetch", fetch);
  renderApp("/");
  expect(await screen.findByText(/temporarily unavailable/)).toBeInTheDocument();
  expect(tokens.access).toBe("a");
  fetch.mockImplementation(async () => json(200, USER));
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Workspace list")).toBeInTheDocument();
});

it("shows a not-found page for unknown addresses", () => {
  renderApp("/no/such/page");
  expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
  expect(screen.getByText("/no/such/page")).toBeInTheDocument();
});
