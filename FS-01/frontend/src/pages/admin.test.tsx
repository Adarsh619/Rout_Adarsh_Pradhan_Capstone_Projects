import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { AdminAnalytics, AdminOrder, VendorEarnings } from "../api/analytics";
import { formatCompactINR } from "../lib/money";
import { errorResponse, jsonResponse, makeUser, mockApi, renderWithProviders, session } from "../test/render";

const admin = makeUser({ role: "admin", name: "Asha Admin" });
const vendor = makeUser({ role: "vendor", name: "Vikram" });

const escrow = { held: 80_730, released: 0, paid: 1_800_000, reversed: 53_820, counts: { held: 1, released: 0, paid: 1, reversed: 1 } };
const days = (n: number, values: Record<number, number> = {}) =>
  Array.from({ length: n }, (_, i) => ({ day: `2026-10-${String(10 + i).padStart(2, "0")}`, sales: values[i] ?? 0, orders: values[i] ? 1 : 0 }));

const analytics = (overrides: Partial<AdminAnalytics> = {}): AdminAnalytics => ({
  range: { from: "2026-10-10", to: "2026-11-08" },
  totals: { gmv: 2_149_500, cancelledValue: 59_800, collected: 2_070_280, refunds: 59_220, paidOrders: 2, averageOrderValue: 1_064_750, commission: 208_970, platformDiscounts: 19_420, platformRevenue: 189_550, payoutsSent: 1_800_000 },
  ordersByStatus: { completed: 1, confirmed: 1 },
  partsByStatus: { delivered: 1, cancelled: 1, placed: 1 },
  daily: days(30, { 28: 2_129_500, 29: 0 }),
  topVendors: [{ vendorId: "v1", storeName: "Vikram Electronics", slug: "vikram-electronics", sales: 2_000_000, orders: 1, commission: 200_000 }],
  topProducts: [{ productId: "p1", title: "Galaxy Phone", storeName: "Vikram Electronics", units: 1, sales: 2_000_000 }],
  escrow,
  failingRefunds: 1,
  refundsOwed: 2_000_000,
  ...overrides,
});

describe("formatting", () => {
  it("writes short rupee amounts for chart axes", () => {
    expect(formatCompactINR(95_000)).toBe("₹950");
    expect(formatCompactINR(2_129_500)).toBe("₹21.3K");
    expect(formatCompactINR(25_000_000)).toBe("₹2.5L");
  });
});

describe("admin analytics", () => {
  it("shows the totals, the daily chart with a table view, top stores and a refund warning", async () => {
    const spy = mockApi({ "POST /api/v1/auth/refresh": () => session(admin), "GET /api/v1/admin/analytics": () => jsonResponse(analytics()) });
    renderWithProviders(<App />, { route: "/admin/analytics" });
    expect(await screen.findByText("₹21,495")).toBeInTheDocument();
    expect(screen.getByText("Platform revenue").nextSibling).toHaveTextContent("₹1,895.50");
    expect(screen.getByRole("alert")).toHaveTextContent("1 refund hasn't gone through yet (₹20,000 still owed to customers).");
    expect(screen.getByRole("link", { name: "See them" })).toHaveAttribute("href", "/admin/orders?refund=failed");
    expect(screen.getByRole("img", { name: /: ₹21.3K, 1 order/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Vikram Electronics" })).toHaveAttribute("href", "/stores/vikram-electronics");

    await userEvent.click(screen.getByRole("button", { name: "Show as table" }));
    const table = screen.getByRole("table", { name: "Daily sales (payments received)" });
    expect(within(table).getAllByRole("row")).toHaveLength(31);

    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    await waitFor(() => {
      const last = spy.mock.calls.filter(([url]) => String(url).includes("/admin/analytics")).at(-1)!;
      const params = new URL(String(last[0]), "http://x").searchParams;
      const span = (Date.parse(params.get("to")!) - Date.parse(params.get("from")!)) / 86_400_000;
      expect(span).toBe(6);
    });
  });
});

describe("vendor earnings", () => {
  it("says where the money is and asks for a payout account when shares are waiting", async () => {
    const earnings: VendorEarnings = {
      range: { from: "2026-10-10", to: "2026-11-08" },
      totals: { sales: 2_000_000, couponDiscounts: 100_000, commission: 190_000, net: 1_710_000, orders: 1 },
      escrow: { ...escrow, held: 0, released: 1_710_000, paid: 0 },
      daily: days(30).map((d) => ({ day: d.day, net: d.sales, orders: d.orders })),
      payoutAccount: false,
      items: [
        { id: "s1", orderNumber: "SS-2026-000001", placedAt: "2026-11-08T05:00:00.000Z", status: "delivered", itemsTotal: 2_000_000, discountShare: 100_000, commission: 190_000, vendorNet: 1_710_000, payout: { status: "released", paidAt: null, reference: null } },
      ],
      page: 1,
      limit: 10,
      total: 1,
    };
    mockApi({ "POST /api/v1/auth/refresh": () => session(vendor), "GET /api/v1/vendor/earnings": () => jsonResponse(earnings) });
    renderWithProviders(<App />, { route: "/vendor/earnings" });
    expect(await screen.findByRole("alert")).toHaveTextContent("₹17,100 is ready to be paid out, but your store has no payout account.");
    expect(screen.getByText("Your share", { selector: "p" }).nextSibling).toHaveTextContent("₹17,100");
    expect(screen.getByText("Released, being paid out", { selector: "td" })).toBeInTheDocument();
    expect(screen.getByText("− ₹1,000 coupon")).toBeInTheDocument();
    expect(screen.getByText("Nothing in this period")).toBeInTheDocument();
  });
});

describe("admin orders and refunds", () => {
  const order = (overrides: Partial<AdminOrder["parts"][number]> = {}): AdminOrder => ({
    id: "o1",
    orderNumber: "SS-2026-000001",
    status: "confirmed",
    createdAt: "2026-11-08T05:00:00.000Z",
    grandTotal: 2_000_000,
    discount: 0,
    coupon: null,
    payment: { provider: "mock", status: "paid", refundedAmount: 0, reference: "pay_1" },
    customer: { name: "Priya Sharma", email: "priya@example.com" },
    parts: [{ id: "s1", storeName: "Vikram Electronics", status: "shipped", payable: 2_000_000, payout: "held", refund: null, canRefund: true, ...overrides }],
  });

  it("asks for a reason, then cancels and refunds the part", async () => {
    let refunded = false;
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(admin),
      "GET /api/v1/admin/orders": () =>
        jsonResponse({ items: [refunded ? order({ status: "cancelled", canRefund: false, refund: { amount: 2_000_000, status: "failed", lastError: "invalid request sent" } }) : order()], page: 1, limit: 10, total: 1 }),
      "POST /api/v1/admin/sub-orders/s1/refund": () => {
        refunded = true;
        return jsonResponse({ part: { id: "s1", status: "cancelled" } });
      },
      "POST /api/v1/admin/sub-orders/s1/refund/retry": () => errorResponse(502, "payment_unavailable", "Payments are unavailable right now."),
    });
    renderWithProviders(<App />, { route: "/admin/orders" });
    await userEvent.click(await screen.findByRole("button", { name: "Cancel and refund" }));
    await userEvent.type(screen.getByLabelText(/Reason/), "Parcel lost in transit");
    await userEvent.click(screen.getByRole("button", { name: "Cancel and refund ₹20,000" }));
    expect(await screen.findByText(/Refund not sent yet/)).toBeInTheDocument();
    expect(screen.getByText(/invalid request sent/)).toBeInTheDocument();
    const body = JSON.parse(spy.mock.calls.find(([url]) => String(url).endsWith("/sub-orders/s1/refund"))![1]!.body as string);
    expect(body).toEqual({ reason: "Parcel lost in transit" });

    await userEvent.click(screen.getByRole("button", { name: "Retry refund" }));
    expect(await screen.findByText("Payments are unavailable right now.")).toBeInTheDocument();
  });

  it("searches by order number or email", async () => {
    const spy = mockApi({ "POST /api/v1/auth/refresh": () => session(admin), "GET /api/v1/admin/orders": () => jsonResponse({ items: [], page: 1, limit: 10, total: 0 }) });
    renderWithProviders(<App />, { route: "/admin/orders" });
    await userEvent.type(await screen.findByLabelText("Order number or customer email"), "priya@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes("q=priya%40example.com"))).toBe(true));
    expect(await screen.findByText("No orders found.")).toBeInTheDocument();
  });
});

describe("commission rates", () => {
  it("lets an admin set a category's rate in percent, sent as basis points", async () => {
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(admin),
      "GET /api/v1/admin/categories": () =>
        jsonResponse({ items: [{ id: "c1", name: "Electronics", slug: "electronics", parentId: null, commissionRateBp: null, isActive: true, sortOrder: 0, productCount: 3 }] }),
      "PATCH /api/v1/admin/categories/c1": () => jsonResponse({ category: {} }),
    });
    renderWithProviders(<App />, { route: "/admin/categories" });
    expect(await screen.findByText(/Commission \(10% platform default\)/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Change\s*commission for Electronics/ }));
    const input = screen.getByLabelText(/Commission percent for Electronics/);
    await userEvent.type(input, "70");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter 0 to 50");
    await userEvent.clear(input);
    await userEvent.type(input, "12.5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      const call = spy.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(call![1]!.body as string)).toEqual({ commissionRateBp: 1250 });
    });
  });
});
