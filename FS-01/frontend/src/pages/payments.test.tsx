import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import type { OwnStore } from "../api/catalog";
import type { Order, PaymentStep } from "../api/orders";
import type { RazorpayFailure, RazorpayOptions } from "../lib/razorpay";
import { errorResponse, jsonResponse, makeUser, mockApi, renderWithProviders, session } from "../test/render";

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "o1",
  orderNumber: "SS-2026-000001",
  status: "pending_payment",
  createdAt: "2026-11-07T10:00:00.000Z",
  itemsTotal: 2_000_000,
  discount: 0,
  shipping: 0,
  grandTotal: 2_000_000,
  payment: { provider: "razorpay", status: "created", paidAt: null, refundedAmount: 0, providerOrderId: "order_rzp_1" },
  reservationExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  shippingAddress: { name: "Priya Sharma", phone: "9876543210", line1: "12 MG Road", line2: null, city: "Bengaluru", state: "Karnataka", pincode: "560001" },
  parts: [
    {
      id: "s1",
      vendor: { storeName: "Vikram Electronics", slug: "vikram-electronics" },
      items: [{ productId: "p1", title: "Galaxy Phone", image: null, price: 2_000_000, qty: 1, lineTotal: 2_000_000 }],
      itemsTotal: 2_000_000,
      payable: 2_000_000,
      status: "awaiting_payment",
      tracking: null,
      timeline: [],
      canCancel: false,
      cancelReason: null,
      refund: null,
    },
  ],
  ...overrides,
});

const payment: PaymentStep = {
  provider: "razorpay",
  providerOrderId: "order_rzp_1",
  amount: 2_000_000,
  currency: "INR",
  expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  keyId: "rzp_test_frontend00000",
};

// Stands in for Razorpay's checkout.js: records the options and lets the test play the customer.
function fakeRazorpay() {
  const state: { options?: RazorpayOptions; onFail?: (r: RazorpayFailure) => void; opened: number } = { opened: 0 };
  window.Razorpay = class {
    constructor(options: RazorpayOptions) {
      state.options = options;
    }
    open() {
      state.opened++;
    }
    on(_event: "payment.failed", handler: (r: RazorpayFailure) => void) {
      state.onFail = handler;
    }
  };
  return state;
}

afterEach(() => {
  delete window.Razorpay;
});

describe("paying with Razorpay", () => {
  it("opens the popup for the order and verifies what Razorpay returns", async () => {
    const rzp = fakeRazorpay();
    const paid = order({ status: "confirmed", payment: { provider: "razorpay", status: "paid", paidAt: "2026-11-07T10:01:00.000Z", refundedAmount: 0, providerOrderId: null } });
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser()),
      "GET /api/v1/orders/o1": () => jsonResponse({ order: order(), payment }),
      "POST /api/v1/checkout/verify": () => jsonResponse({ order: paid }),
    });
    renderWithProviders(<App />, { route: "/orders/o1" });
    expect(await screen.findByText("success@razorpay")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Pay ₹20,000 with Razorpay" }));

    await waitFor(() => expect(rzp.opened).toBe(1));
    expect(rzp.options).toMatchObject({
      key: "rzp_test_frontend00000",
      amount: 2_000_000,
      currency: "INR",
      order_id: "order_rzp_1",
      prefill: { name: "Priya Customer", email: "customer@shopsphere.test", contact: "+919876543210" },
    });
    expect(screen.getByRole("button", { name: "Waiting for Razorpay…" })).toBeDisabled();

    rzp.options!.handler({ razorpay_order_id: "order_rzp_1", razorpay_payment_id: "pay_rzp_1", razorpay_signature: "sig" });
    expect(await screen.findByText(/Payment received/)).toBeInTheDocument();
    const call = spy.mock.calls.find(([url]) => String(url).endsWith("/checkout/verify"))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ orderId: "o1", providerOrderId: "order_rzp_1", providerPaymentId: "pay_rzp_1", signature: "sig" });
  });

  it("explains a failed payment and lets the customer try again after closing the popup", async () => {
    const rzp = fakeRazorpay();
    mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser()),
      "GET /api/v1/orders/o1": () => jsonResponse({ order: order(), payment }),
    });
    renderWithProviders(<App />, { route: "/orders/o1" });
    await userEvent.click(await screen.findByRole("button", { name: "Pay ₹20,000 with Razorpay" }));
    await waitFor(() => expect(rzp.opened).toBe(1));
    rzp.onFail!({ error: { description: "Payment failed because UPI ID is invalid" } });
    rzp.options!.modal!.ondismiss!();
    expect(await screen.findByRole("alert")).toHaveTextContent("UPI ID is invalid. Nothing was charged");
    expect(screen.getByRole("button", { name: "Pay ₹20,000 with Razorpay" })).toBeEnabled();
  });

  it("shows a cancelled part's refund", async () => {
    mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser()),
      "GET /api/v1/orders/o1": () =>
        jsonResponse({
          order: order({
            status: "cancelled",
            payment: { provider: "razorpay", status: "refunded", paidAt: "2026-11-07T10:01:00.000Z", refundedAmount: 2_000_000, providerOrderId: null },
            parts: [{ ...order().parts[0]!, status: "cancelled", refund: { amount: 2_000_000, status: "processed" } }],
          }),
          payment: null,
        }),
    });
    renderWithProviders(<App />, { route: "/orders/o1" });
    expect(await screen.findByText(/Refund of ₹20,000: sent to your original payment method/)).toBeInTheDocument();
    expect(screen.getByText("Refunded")).toBeInTheDocument();
  });
});

describe("vendor payout account", () => {
  const store = (overrides: Partial<OwnStore> = {}): OwnStore => ({
    id: "v1",
    storeName: "Vikram Electronics",
    slug: "vikram-electronics",
    description: "",
    logoUrl: null,
    ratingAvg: 0,
    ratingCount: 0,
    since: "2026-11-01T00:00:00.000Z",
    logoKey: null,
    status: "approved",
    rejectionReason: null,
    contactEmail: "vendor@shopsphere.test",
    phone: "9876543210",
    gstin: null,
    commissionRateBp: null,
    submittedAt: "2026-11-01T00:00:00.000Z",
    approvedAt: "2026-11-01T00:00:00.000Z",
    payout: null,
    ...overrides,
  });

  it("asks for an account, shows field errors, then shows only the last 4 digits", async () => {
    let attempt = 0;
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(makeUser({ role: "vendor", name: "Vikram" })),
      "GET /api/v1/vendors/me": () => jsonResponse({ store: store() }),
      "GET /api/v1/vendor/products": () => jsonResponse({ items: [], page: 1, limit: 20, total: 0, counts: { draft: 0, active: 0, inactive: 0 } }),
      "PUT /api/v1/vendors/me/payout": () =>
        ++attempt === 1
          ? errorResponse(400, "validation_error", "Some fields need fixing", { fields: [{ field: "ifsc", message: "Enter the 11-character IFSC, e.g. HDFC0001234" }] })
          : jsonResponse({ store: store({ payout: { accountHolder: "Vikram Rao", bankLast4: "9012", ifsc: "HDFC0001234", provider: "mock" } }), payoutsStarted: 2 }),
    });
    renderWithProviders(<App />, { route: "/vendor" });
    expect(await screen.findByText(/Add an account so delivered orders can be paid out/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Account holder name"), "Vikram Rao");
    await userEvent.type(screen.getByLabelText("Account number"), "123456789012");
    await userEvent.type(screen.getByLabelText("IFSC"), "hdfc1234");
    await userEvent.click(screen.getByRole("button", { name: "Save payout account" }));
    expect(await screen.findByText("Enter the 11-character IFSC, e.g. HDFC0001234")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Save payout account" }));
    expect(await screen.findByText(/2 waiting payouts are being sent now/)).toBeInTheDocument();
    expect(screen.getByText(/account ending/)).toHaveTextContent("Vikram Rao · account ending 9012 · HDFC0001234");
    const body = JSON.parse(spy.mock.calls.filter(([url]) => String(url).endsWith("/vendors/me/payout"))[1]![1]!.body as string);
    expect(body).toEqual({ accountHolder: "Vikram Rao", accountNumber: "123456789012", ifsc: "hdfc1234" });
  });
});
