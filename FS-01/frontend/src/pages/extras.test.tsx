import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { Cart } from "../api/cart";
import type { Product } from "../api/catalog";
import type { ReviewPage } from "../api/reviews";
import { errorResponse, jsonResponse, makeUser, mockApi, renderWithProviders, session } from "../test/render";

const cart = (overrides: Partial<Cart> = {}): Cart => ({
  groups: [
    {
      vendor: { id: "v1", storeName: "Vikram Electronics", slug: "vikram-electronics" },
      items: [{ productId: "p1", title: "Galaxy Phone", image: null, price: 2_000_000, mrp: 2_000_000, qty: 1, stock: 5, lineTotal: 2_000_000, problem: null }],
      subtotal: 2_000_000,
    },
  ],
  itemCount: 1,
  itemsTotal: 2_000_000,
  problems: 0,
  canCheckout: true,
  coupon: null,
  couponProblem: null,
  discount: 0,
  grandTotal: 2_000_000,
  ...overrides,
});

const signedIn = (user = makeUser()) => ({ "POST /api/v1/auth/refresh": () => session(user) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("coupons in the cart", () => {
  it("applies a code, shows the discount and the new total, and explains a refused code", async () => {
    let attempt = 0;
    const spy = mockApi({
      ...signedIn(),
      "GET /api/v1/cart": () => jsonResponse({ cart: cart() }),
      "POST /api/v1/cart/coupon": () =>
        ++attempt === 1
          ? errorResponse(409, "coupon_invalid", "This coupon has expired.")
          : jsonResponse({
              cart: cart({ coupon: { code: "WELCOME10", description: "10% off, up to ₹200", scope: "platform", storeName: null }, discount: 20_000, grandTotal: 1_980_000 }),
            }),
    });
    renderWithProviders(<App />, { route: "/cart" });
    const box = await screen.findByLabelText("Coupon code");
    await userEvent.type(box, "oldcode");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("This coupon has expired.")).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "welcome10");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByText("10% off, up to ₹200")).toBeInTheDocument();
    expect(screen.getByText("Coupon WELCOME10").nextSibling).toHaveTextContent("₹200");
    expect(screen.getByText("₹19,800")).toBeInTheDocument();
    const body = JSON.parse(spy.mock.calls.filter(([url]) => String(url).endsWith("/cart/coupon")).at(-1)![1]!.body as string);
    expect(body).toEqual({ code: "welcome10" });
  });

  it("keeps a coupon that no longer applies visible, with the reason", async () => {
    mockApi({
      ...signedIn(),
      "GET /api/v1/cart": () =>
        jsonResponse({
          cart: cart({ coupon: { code: "VIKRAM5", description: null, scope: "vendor", storeName: "Vikram Electronics" }, couponProblem: "Add items worth ₹200 more to use this coupon (from this store)." }),
        }),
    });
    renderWithProviders(<App />, { route: "/cart" });
    expect(await screen.findByText(/Add items worth ₹200 more/)).toBeInTheDocument();
    expect(screen.getByText(/Vikram Electronics only/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove\s*coupon VIKRAM5/ })).toBeInTheDocument();
  });
});

describe("reviews on the product page", () => {
  const product: Product = {
    id: "p1", title: "Galaxy Phone", slug: "galaxy-phone", description: "", brand: "Samsung", category: null,
    vendor: { id: "v1", storeName: "Vikram Electronics", slug: "vikram-electronics" },
    images: [], price: 2_000_000, mrp: 2_000_000, discountPercent: 0, inStock: true, stock: 3,
    attributes: {}, ratingAvg: 4, ratingCount: 2, createdAt: "2026-11-01T00:00:00.000Z",
  };
  const reviews = (overrides: Partial<ReviewPage> = {}): ReviewPage => ({
    items: [
      { id: "r1", rating: 5, title: "Love it", body: "Battery lasts two days.", authorName: "Asha", verified: true, createdAt: "2026-11-05T10:00:00.000Z" },
      { id: "r2", rating: 3, title: null, body: "Fine for the price.", authorName: "Emily Johnson", verified: false, createdAt: "2026-10-01T10:00:00.000Z" },
    ],
    page: 1,
    limit: 5,
    total: 2,
    summary: { ratingAvg: 4, ratingCount: 2, stars: { 5: 1, 4: 0, 3: 1, 2: 0, 1: 0 } },
    viewer: { canReview: true, reason: null, mine: null },
    ...overrides,
  });

  it("shows the breakdown and reviews, and lets a customer with a delivered order post one", async () => {
    let posted = false;
    const spy = mockApi({
      ...signedIn(),
      "GET /api/v1/products/p1": () => jsonResponse({ product }),
      "GET /api/v1/products/p1/reviews": () => jsonResponse(posted ? reviews({ viewer: { canReview: false, reason: "already_reviewed", mine: null } }) : reviews()),
      "POST /api/v1/products/p1/reviews": () => {
        posted = true;
        return jsonResponse({ review: {}, summary: { ratingAvg: 4.3, ratingCount: 3 } }, 201);
      },
    });
    renderWithProviders(<App />, { route: "/products/p1" });
    const section = await screen.findByRole("region", { name: "Customer reviews" });
    expect(await within(section).findByText("Battery lasts two days.")).toBeInTheDocument();
    expect(within(section).getByText("Verified purchase")).toBeInTheDocument();
    expect(within(section).getAllByText(/Verified purchase/)).toHaveLength(1);

    const form = within(section).getByRole("form", { name: "Write a review" });
    await userEvent.click(within(form).getByRole("button", { name: "4 stars" }));
    await userEvent.type(within(form).getByLabelText("Your review"), "Good phone, fast delivery.");
    await userEvent.click(within(form).getByRole("button", { name: "Post review" }));
    expect(await within(section).findByText("Thanks, you've reviewed this product.")).toBeInTheDocument();
    const body = JSON.parse(spy.mock.calls.find(([url, init]) => String(url).endsWith("/reviews") && init?.method === "POST")![1]!.body as string);
    expect(body).toEqual({ rating: 4, title: "", body: "Good phone, fast delivery." });
  });

  it("tells a customer without a delivered order why they can't review yet", async () => {
    mockApi({
      ...signedIn(),
      "GET /api/v1/products/p1": () => jsonResponse({ product }),
      "GET /api/v1/products/p1/reviews": () => jsonResponse(reviews({ viewer: { canReview: false, reason: "not_delivered", mine: null } })),
    });
    renderWithProviders(<App />, { route: "/products/p1" });
    expect(await screen.findByText(/once an order with it has been delivered to you/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Write a review" })).not.toBeInTheDocument();
  });
});

describe("coupons page", () => {
  it("lets a vendor create a coupon in rupees and percent, sent to the API in paise and basis points", async () => {
    let created = false;
    const coupon = { id: "c1", code: "VIKRAM5", scope: "vendor", vendorId: "v1", type: "percent", value: 500, maxDiscount: 50_000, minOrder: 100_000, startsAt: null, endsAt: null, usageLimit: null, perUserLimit: 1, usedCount: 0, isActive: true, description: null, createdAt: "2026-11-07T00:00:00.000Z" };
    const spy = mockApi({
      ...signedIn(makeUser({ role: "vendor", name: "Vikram" })),
      "GET /api/v1/vendor/coupons": () => jsonResponse({ items: created ? [coupon] : [], page: 1, limit: 20, total: created ? 1 : 0 }),
      "POST /api/v1/vendor/coupons": () => {
        created = true;
        return jsonResponse({ coupon }, 201);
      },
    });
    renderWithProviders(<App />, { route: "/vendor/coupons" });
    const form = await screen.findByRole("form", { name: "New coupon" });
    await userEvent.type(within(form).getByLabelText("Code"), "VIKRAM5");
    await userEvent.type(within(form).getByLabelText("Percent off"), "5");
    await userEvent.type(within(form).getByLabelText("Maximum discount (₹, optional)"), "500");
    await userEvent.type(within(form).getByLabelText("Minimum order (₹, optional)"), "1000");
    await userEvent.click(within(form).getByRole("button", { name: "Create coupon" }));
    expect(await screen.findByText("5% off, up to ₹500 on ₹1,000 or more")).toBeInTheDocument();
    const body = JSON.parse(spy.mock.calls.find(([url, init]) => String(url).endsWith("/vendor/coupons") && init?.method === "POST")![1]!.body as string);
    expect(body).toMatchObject({ code: "VIKRAM5", type: "percent", value: 500, maxDiscount: 50_000, minOrder: 100_000, usageLimit: null, perUserLimit: 1 });
  });
});

describe("invoices", () => {
  it("fetches a short-lived link and opens it", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    mockApi({
      ...signedIn(makeUser({ role: "vendor", name: "Vikram" })),
      "GET /api/v1/vendor/orders": () =>
        jsonResponse({
          items: [
            {
              id: "s1", orderNumber: "SS-2026-000001", status: "placed", placedAt: "2026-11-07T10:00:00.000Z", items: [], itemsTotal: 100_000, discountShare: 0, discountBy: null,
              payable: 100_000, commission: 10_000, vendorNet: 90_000, invoiceNumber: "INV-2026-000001", customer: { name: "Priya" }, shippingAddress: null,
              tracking: null, timeline: [], nextStatus: "packed", cancelReason: null, payout: null,
            },
          ],
          page: 1, limit: 20, total: 1, counts: { placed: 1, packed: 0, shipped: 0, delivered: 0, cancelled: 0 },
        }),
      "GET /api/v1/invoices/s1": () => jsonResponse({ invoiceNumber: "INV-2026-000001", url: "http://storage.test/invoices/INV-2026-000001.pdf", expiresInSeconds: 300 }),
    });
    renderWithProviders(<App />, { route: "/vendor/orders" });
    await userEvent.click(await screen.findByRole("button", { name: "Download invoice INV-2026-000001" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://storage.test/invoices/INV-2026-000001.pdf"));
  });
});
