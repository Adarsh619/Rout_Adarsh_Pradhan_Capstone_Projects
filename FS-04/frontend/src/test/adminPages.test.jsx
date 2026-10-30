import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import MockCheckout from "../pages/MockCheckout";
import Reports, { POLL_EVERY_MS } from "../pages/Reports";
import { FIRST_RULE_WARNING, WorkflowEditor } from "../pages/Workflows";
import { RequireRole, WorkspaceContext } from "../workspace";

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const workspace = { name: "Acme", slug: "acme" };
const withRole = (role, ui, path = "/") => render(
  <WorkspaceContext.Provider value={{ role, workspace, projects: [], members: [] }}>
    <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
  </WorkspaceContext.Provider>
);

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("RequireRole", () => {
  it("explains instead of showing an admin page to a member", () => {
    withRole("member", <RequireRole minimum="admin"><p>Audit log</p></RequireRole>);
    expect(screen.getByRole("heading", { name: "Admins only" })).toBeInTheDocument();
    expect(screen.getByText(/You're a member in Acme/)).toBeInTheDocument();
    expect(screen.queryByText("Audit log")).not.toBeInTheDocument();
  });
  it("shows the page to anyone with the role or higher", () => {
    withRole("owner", <RequireRole minimum="admin"><p>Audit log</p></RequireRole>);
    expect(screen.getByText("Audit log")).toBeInTheDocument();
  });
});

describe("WorkflowEditor", () => {
  const wf = {
    id: 1, name: "Support", is_default: false,
    statuses: [{ id: 10, name: "Open", category: "todo", order: 0 }, { id: 11, name: "Closed", category: "done", order: 1 }],
    transitions: [],
  };
  const actNow = (fn) => (...a) => fn(...a);

  it("warns before the first rule turns free movement off", async () => {
    const fetch = vi.fn(async () => json({ id: 5 }, 201));
    vi.stubGlobal("fetch", fetch);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    withRole("admin", <WorkflowEditor wf={wf} act={actNow} />);
    fireEvent.change(screen.getByLabelText("From status"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("To status"), { target: { value: "11" } });
    fireEvent.click(screen.getByRole("button", { name: "Add transition" }));
    expect(confirm).toHaveBeenCalledWith(FIRST_RULE_WARNING);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("won't add a move from a status to itself", () => {
    withRole("admin", <WorkflowEditor wf={wf} act={actNow} />);
    fireEvent.change(screen.getByLabelText("From status"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("To status"), { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "Add transition" })).toBeDisabled();
    expect(screen.getByText("Pick two different statuses.")).toBeInTheDocument();
  });

  it("names the projects using a workflow and hides Delete for them", () => {
    withRole("admin", <WorkflowEditor wf={wf} act={actNow} usedBy={[{ id: 5, key: "WEB" }]} />);
    expect(screen.getByText("Used by WEB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete workflow" })).not.toBeInTheDocument();
  });

  it("swaps two statuses' order to move a column", async () => {
    const fetch = vi.fn(async () => json({}));
    vi.stubGlobal("fetch", fetch);
    withRole("admin", <WorkflowEditor wf={wf} act={actNow} />);
    fireEvent.click(screen.getByRole("button", { name: "Move Open right" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls.map(([url, o]) => [url, JSON.parse(o.body)])).toEqual([
      ["/api/statuses/10/", { order: 1 }], ["/api/statuses/11/", { order: 0 }],
    ]);
  });
});

describe("Reports", () => {
  it("checks back until the worker's new report appears", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const old = { id: 1, created_at: "2026-10-26T06:00:00Z", data: { period_start: "2026-10-19", period_end: "2026-10-26", created: 3, completed: 1, open_total: 9, overdue: 0 } };
    const fresh = { ...old, id: 2, data: { ...old.data, period_start: "2026-10-23", period_end: "2026-10-30" } };
    let listed = 0;
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url.includes("/generate/")) return json({ task_id: "abc" }, 202);
      listed += 1;
      return json({ results: listed < 3 ? [old] : [fresh, old] });
    }));
    withRole("admin", <Reports />);
    expect(await screen.findByText(/19 Oct|Oct 19/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate now" }));
    expect(await screen.findByRole("button", { name: "Generating…" })).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_EVERY_MS * 2); });
    expect(await screen.findByText("New report ready.")).toBeInTheDocument();
    expect(screen.getByText(/23 Oct|Oct 23/)).toBeInTheDocument();
  });
});

describe("MockCheckout", () => {
  const billing = (extra) => ({
    mode: "mock", plan: "free", status: "active", has_subscription: false,
    plans: { free: { name: "Free", price_usd: 0, limits: {} }, pro: { name: "Pro", price_usd: 10, limits: { projects: 20 } }, business: { name: "Business", price_usd: 25, limits: { projects: null } } },
    ...extra,
  });
  const renderCheckout = (role, path, data = billing()) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(data)));
    return withRole(role, <Routes><Route path="/w/:slug/billing/checkout" element={<MockCheckout />} /></Routes>, path);
  };

  it("falls back to Pro when the link names a plan that can't be bought", async () => {
    renderCheckout("owner", "/w/acme/billing/checkout?plan=free");
    expect(await screen.findByRole("heading", { name: "TaskFlow Pro" })).toBeInTheDocument();
  });
  it("tells non-owners they can't change the plan", async () => {
    renderCheckout("admin", "/w/acme/billing/checkout?plan=pro");
    expect(await screen.findByText(/Only the workspace owner can change the plan/)).toBeInTheDocument();
  });
  it("asks before cancelling a subscription", async () => {
    renderCheckout("owner", "/w/acme/billing/checkout?manage=1", billing({ plan: "pro", has_subscription: true }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel subscription" }));
    expect(confirm).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1); // only the billing load, no cancellation sent
  });
});
