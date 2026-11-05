import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { Cart } from "../api/cart";
import type { Address, Order, PaymentStep, VendorPart } from "../api/orders";
import { errorResponse, jsonResponse, makeUser, mockApi, renderWithProviders, session } from "../test/render";

const customer = makeUser();

const cart = (overrides: Partial<Cart> = {}): Cart => ({
  groups: [
    {
      vendor: { id: "v1", storeName: "Vikram Electronics", slug: "vikram-electronics" },
      items: [{ productId: "p1", title: "Galaxy Phone", image: null, price: 2_000_000, mrp: 2_000_000, qty: 1, stock: 5, lineTotal: 2_000_000, problem: null }],
      subtotal: 2_000_000,
    },
    {
      vendor: { id: "v2", storeName: "Meera Gadgets", slug: "meera-gadgets" },
      items: [{ productId: "p2", title: "USB-C Cable", image: null, price: 29_900, mrp: 29_900, qty: 2, stock: 3, lineTotal: 59_800, problem: null }],
      subtotal: 59_800,
    },
  ],
  itemCount: 3,
  itemsTotal: 2_059_800,
  problems: 0,
  canCheckout: true,
  ...overrides,
});

const address: Address = {
  id: "a1",
  label: "Home",
  name: "Priya Sharma",
  phone: "9876543210",
  line1: "12 MG Road",
  line2: null,
  city: "Bengaluru",
  state: "Karnataka",
  pincode: "560001",
  isDefault: true,
};

const part = (overrides: Partial<Order["parts"][number]> = {}): Order["parts"][number] => ({
  id: "s1",
  vendor: { storeName: "Vikram Electronics", slug: "vikram-electronics" },
  items: [{ productId: "p1", title: "Galaxy Phone", image: null, price: 2_000_000, qty: 1, lineTotal: 2_000_000 }],
  itemsTotal: 2_000_000,
  payable: 2_000_000,
  status: "awaiting_payment",
  tracking: null,
  timeline: [{ status: "awaiting_payment", at: "2026-11-06T10:00:00.000Z", byRole: "customer", note: "Order placed, waiting for payment" }],
  canCancel: false,
  cancelReason: null,
  ...overrides,
});

const order = (overrides: Partial<Order> = {}): Order => ({
  id: "o1",
  orderNumber: "SS-2026-000001",
  status: "pending_payment",
  createdAt: "2026-11-06T10:00:00.000Z",
  itemsTotal: 2_000_000,
  discount: 0,
  shipping: 0,
  grandTotal: 2_000_000,
  payment: { provider: "mock", status: "created", paidAt: null, providerOrderId: "order_mock_1" },
  reservationExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  shippingAddress: { name: "Priya Sharma", phone: "9876543210", line1: "12 MG Road", line2: null, city: "Bengaluru", state: "Karnataka", pincode: "560001" },
  parts: [part()],
  ...overrides,
});

const payment: PaymentStep = { provider: "mock", providerOrderId: "order_mock_1", amount: 2_000_000, currency: "INR", expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };

const signedIn = (user = customer) => ({ "POST /api/v1/auth/refresh": () => session(user) });

describe("cart", () => {
  it("adds a product from its page and shows the count in the header", async () => {
    let current = cart({ groups: [], itemCount: 0, itemsTotal: 0, canCheckout: false });
    const spy = mockApi({
      "GET /api/v1/products/p1": () =>
        jsonResponse({
          product: {
            id: "p1", title: "Galaxy Phone", slug: "galaxy-phone", description: "", brand: "Samsung", category: null,
            vendor: { id: "v1", storeName: "Vikram Electronics", slug: "vikram-electronics" },
            images: [], price: 2_000_000, mrp: 2_000_000, discountPercent: 0, inStock: true, stock: 3,
            attributes: {}, ratingAvg: 0, ratingCount: 0, createdAt: "2026-11-01T00:00:00.000Z",
          },
        }),
      "GET /api/v1/cart": () => jsonResponse({ cart: current }),
      "POST /api/v1/cart/items": () => {
        current = cart({ groups: [cart().groups[0]!], itemCount: 2, itemsTotal: 4_000_000 });
        return jsonResponse({ cart: current }, 201);
      },
    });
    renderWithProviders(<App />, { route: "/products/p1" });
    const qty = await screen.findByLabelText("Qty");
    // Never more than the stock left.
    expect(within(qty).getAllByRole("option")).toHaveLength(3);
    await userEvent.selectOptions(qty, "2");
    await userEvent.click(screen.getByRole("button", { name: "Add to cart" }));
    expect(await screen.findByText(/Added to your cart/)).toBeInTheDocument();
    const call = spy.mock.calls.find(([url, init]) => String(url).endsWith("/cart/items") && init?.method === "POST")!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ productId: "p1", qty: 2 });
    expect(screen.getByRole("link", { name: "Cart, 2 items" })).toBeInTheDocument();
  });

  it("groups items by store and blocks checkout when something changed", async () => {
    const changed = cart();
    changed.groups[1]!.items[0] = { ...changed.groups[1]!.items[0]!, problem: "not_enough_stock", stock: 1 };
    mockApi({ "GET /api/v1/cart": () => jsonResponse({ cart: { ...changed, problems: 1, canCheckout: false } }) });
    renderWithProviders(<App />, { route: "/cart" });
    expect(await screen.findByRole("heading", { name: /Sold by Vikram Electronics/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Sold by Meera Gadgets/ })).toBeInTheDocument();
    expect(screen.getByText(/Not enough in stock for this quantity. Only 1 left./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Proceed to checkout" })).toBeDisabled();
  });

  it("asks a guest to sign in before checkout", async () => {
    mockApi({ "GET /api/v1/cart": () => jsonResponse({ cart: cart() }) });
    renderWithProviders(<App />, { route: "/cart" });
    expect(await screen.findByRole("link", { name: "Sign in to check out" })).toHaveAttribute("href", "/login?next=%2Fcheckout");
  });
});

describe("checkout and payment", () => {
  it("places the order with the chosen address and the total the shopper saw, then opens the payment screen", async () => {
    const spy = mockApi({
      ...signedIn(),
      "GET /api/v1/cart": () => jsonResponse({ cart: cart() }),
      "GET /api/v1/account/addresses": () => jsonResponse({ items: [address] }),
      "POST /api/v1/checkout": () => jsonResponse({ order: order(), payment }, 201),
      "GET /api/v1/orders/o1": () => jsonResponse({ order: order(), payment }),
    });
    renderWithProviders(<App />, { route: "/checkout" });
    expect(await screen.findByRole("radio", { name: /Priya Sharma/ })).toBeChecked();
    expect(screen.getByText(/Part 2 of 2/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Place order and pay" }));

    expect(await screen.findByRole("heading", { name: "Order SS-2026-000001" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Pay ₹20,000 \(test\)/ })).toBeInTheDocument();
    expect(screen.getByText(/Items held for 1[45]:\d\d/)).toBeInTheDocument();
    const call = spy.mock.calls.find(([url]) => String(url).endsWith("/checkout"))!;
    expect(JSON.parse(call[1]!.body as string)).toEqual({ addressId: "a1", expectedTotal: 2_059_800 });
  });

  it("shows a new address form when there are none, and explains a price change", async () => {
    mockApi({
      ...signedIn(),
      "GET /api/v1/cart": () => jsonResponse({ cart: cart() }),
      "GET /api/v1/account/addresses": () => jsonResponse({ items: [] }),
      "POST /api/v1/account/addresses": () => jsonResponse({ address, items: [address] }, 201),
      "POST /api/v1/checkout": () => errorResponse(409, "price_changed", "Prices changed since you opened checkout. Check the new total."),
    });
    renderWithProviders(<App />, { route: "/checkout" });
    const form = await screen.findByRole("form", { name: "New address" });
    await userEvent.type(within(form).getByLabelText("Full name"), "Priya Sharma");
    await userEvent.click(within(form).getByRole("button", { name: "Save address" }));
    expect(await screen.findByRole("radio", { name: /Priya Sharma/ })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: "Place order and pay" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Prices changed since you opened checkout");
  });

  it("pays through the test gateway and verifies the signed result", async () => {
    const paid = order({
      status: "confirmed",
      payment: { provider: "mock", status: "paid", paidAt: "2026-11-06T10:01:00.000Z", providerOrderId: null },
      reservationExpiresAt: null,
      parts: [part({ status: "placed", canCancel: true })],
    });
    const spy = mockApi({
      ...signedIn(),
      "GET /api/v1/orders/o1": () => jsonResponse({ order: order(), payment }),
      "POST /api/v1/payments/mock/pay": () => jsonResponse({ providerOrderId: "order_mock_1", providerPaymentId: "pay_mock_1", signature: "abc" }),
      "POST /api/v1/checkout/verify": () => jsonResponse({ order: paid }),
    });
    renderWithProviders(<App />, { route: "/orders/o1" });
    await userEvent.click(await screen.findByRole("button", { name: /Pay ₹20,000 \(test\)/ }));
    expect(await screen.findByText(/Payment received/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /\(test\)/ })).not.toBeInTheDocument();
    const verify = spy.mock.calls.find(([url]) => String(url).endsWith("/checkout/verify"))!;
    expect(JSON.parse(verify[1]!.body as string)).toEqual({ orderId: "o1", providerOrderId: "order_mock_1", providerPaymentId: "pay_mock_1", signature: "abc" });
    expect(screen.getByRole("button", { name: "Cancel this part" })).toBeInTheDocument();
  });

  it("keeps the order payable after a declined test payment", async () => {
    mockApi({
      ...signedIn(),
      "GET /api/v1/orders/o1": () => jsonResponse({ order: order(), payment }),
      "POST /api/v1/payments/mock/pay": () => errorResponse(402, "payment_failed", "The test payment was declined. Nothing was charged; you can try again."),
    });
    renderWithProviders(<App />, { route: "/orders/o1" });
    await userEvent.click(await screen.findByRole("button", { name: "Simulate a failed payment" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("declined");
    expect(screen.getByRole("button", { name: /Pay ₹20,000 \(test\)/ })).toBeEnabled();
  });

  it("shows each store's progress, with tracking once shipped", async () => {
    mockApi({
      ...signedIn(),
      "GET /api/v1/orders/o1": () =>
        jsonResponse({
          order: order({
            status: "confirmed",
            payment: { provider: "mock", status: "paid", paidAt: "2026-11-06T10:01:00.000Z", providerOrderId: null },
            parts: [
              part({
                status: "shipped",
                tracking: { carrier: "Delhivery", number: "DL123456" },
                timeline: [
                  { status: "placed", at: "2026-11-06T10:01:00.000Z", byRole: "system", note: null },
                  { status: "packed", at: "2026-11-06T11:00:00.000Z", byRole: "vendor", note: null },
                  { status: "shipped", at: "2026-11-06T12:00:00.000Z", byRole: "vendor", note: null },
                ],
              }),
            ],
          }),
          payment: null,
        }),
    });
    renderWithProviders(<App />, { route: "/orders/o1" });
    const progress = await screen.findByRole("list", { name: "Delivery progress" });
    expect(within(progress).getByText("Shipped").closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(progress).getByText("Delivered")).toHaveTextContent("(not yet)");
    expect(screen.getByText("Tracking: Delhivery DL123456")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel this part" })).not.toBeInTheDocument();
  });
});

describe("vendor orders", () => {
  const vendorPart = (overrides: Partial<VendorPart> = {}): VendorPart => ({
    id: "s1",
    orderNumber: "SS-2026-000001",
    status: "packed",
    placedAt: "2026-11-06T10:01:00.000Z",
    items: [{ productId: "p1", title: "Galaxy Phone", image: null, price: 2_000_000, qty: 1, lineTotal: 2_000_000 }],
    itemsTotal: 2_000_000,
    payable: 2_000_000,
    commission: 300_000,
    vendorNet: 1_700_000,
    customer: { name: "Priya Sharma" },
    shippingAddress: order().shippingAddress,
    tracking: null,
    timeline: [],
    nextStatus: "shipped",
    cancelReason: null,
    ...overrides,
  });

  it("shows what the vendor earns and needs tracking to ship", async () => {
    const spy = mockApi({
      ...signedIn(makeUser({ role: "vendor", name: "Vikram" })),
      "GET /api/v1/vendor/orders": () =>
        jsonResponse({ items: [vendorPart()], page: 1, limit: 20, total: 1, counts: { placed: 0, packed: 1, shipped: 0, delivered: 0, cancelled: 0 } }),
      "POST /api/v1/vendor/orders/s1/status": () =>
        errorResponse(400, "validation_error", "Some fields need fixing", { fields: [{ field: "tracking.number", message: "Enter the tracking number" }] }),
    });
    renderWithProviders(<App />, { route: "/vendor/orders" });
    expect(await screen.findByText("You receive")).toBeInTheDocument();
    expect(screen.getByText("₹17,000")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Packed (1)" })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Courier"), "Delhivery");
    await userEvent.click(screen.getByRole("button", { name: "Mark as shipped" }));
    expect(await screen.findByText("Enter the tracking number")).toBeInTheDocument();
    await waitFor(() => {
      const call = spy.mock.calls.find(([url]) => String(url).endsWith("/vendor/orders/s1/status"))!;
      expect(JSON.parse(call[1]!.body as string)).toEqual({ status: "shipped", tracking: { carrier: "Delhivery", number: "" } });
    });
  });
});
