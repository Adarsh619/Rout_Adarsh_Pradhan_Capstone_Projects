import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { OwnStore, ProductCard } from "../api/catalog";
import { formatINR, parseRupees, rupeesInput } from "../lib/money";
import { errorResponse, jsonResponse, makeUser, mockApi, renderWithProviders, session } from "../test/render";

const card = (overrides: Partial<ProductCard> = {}): ProductCard => ({
  id: "p1",
  title: "Galaxy Phone",
  brand: "Samsung",
  image: { url: "http://storage.test/p1.png", alt: "Galaxy Phone" },
  price: 1_999_900,
  mrp: 2_499_900,
  discountPercent: 20,
  inStock: true,
  ratingAvg: 4.5,
  ratingCount: 12,
  vendor: { storeName: "Vikram Electronics", slug: "vikram-electronics" },
  ...overrides,
});

const store = (overrides: Partial<OwnStore> = {}): OwnStore => ({
  id: "s1",
  storeName: "Vikram Electronics",
  slug: "vikram-electronics",
  description: "Phones",
  logoUrl: null,
  ratingAvg: 0,
  ratingCount: 0,
  since: "2026-11-01T00:00:00.000Z",
  logoKey: null,
  status: "pending",
  rejectionReason: null,
  contactEmail: "vendor@shopsphere.test",
  phone: "9876543210",
  gstin: null,
  commissionRateBp: null,
  submittedAt: "2026-11-01T00:00:00.000Z",
  approvedAt: null,
  payout: null,
  ...overrides,
});

const categories = [
  {
    id: "c1",
    name: "Electronics",
    slug: "electronics",
    children: [
      { id: "c2", name: "Smartphones", slug: "smartphones", children: [] },
      { id: "c3", name: "Laptops", slug: "laptops", children: [] },
    ],
  },
];

const bodyOf = (spy: ReturnType<typeof mockApi>, method: string, pathEnd: string) => {
  const call = spy.mock.calls.find(([url, init]) => String(url).endsWith(pathEnd) && (init?.method ?? "GET") === method);
  return call ? JSON.parse(call[1]!.body as string) : undefined;
};

describe("money", () => {
  it("formats paise as rupees and reads what vendors type", () => {
    expect(formatINR(1_999_900)).toBe("₹19,999");
    expect(formatINR(1_999_950)).toBe("₹19,999.50");
    expect(parseRupees("1,999")).toBe(199_900);
    expect(parseRupees("₹ 1999.5")).toBe(199_950);
    expect(parseRupees("12.345")).toBeUndefined();
    expect(parseRupees("abc")).toBeUndefined();
    expect(rupeesInput(199_950)).toBe("1999.50");
  });
});

describe("shopping", () => {
  it("lists products and narrows them by department, keeping the choice in the request", async () => {
    const spy = mockApi({
      "GET /api/v1/health": () => errorResponse(503, "down"),
      "GET /api/v1/categories": () => jsonResponse({ items: categories }),
      "GET /api/v1/products": ({ url }) =>
        jsonResponse({ items: url.includes("category=electronics") ? [card()] : [card(), card({ id: "p2", title: "Cotton Shirt" })], page: 1, limit: 24, total: 2 }),
    });
    renderWithProviders(<App />);

    expect(await screen.findByText("Cotton Shirt")).toBeInTheDocument();
    const product = screen.getAllByRole("article")[0]!;
    expect(within(product).getByText("₹19,999")).toBeInTheDocument();
    expect(within(product).getByText("20% off")).toBeInTheDocument();
    expect(within(product).getByText("Sold by Vikram Electronics")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Electronics" }));
    await waitFor(() => expect(screen.queryByText("Cotton Shirt")).not.toBeInTheDocument());
    // Its sub-categories are offered next.
    expect(screen.getByRole("button", { name: "Smartphones" })).toBeInTheDocument();
    expect(spy.mock.calls.some(([url]) => String(url).includes("/products?category=electronics"))).toBe(true);
  });

  it("shows a product with its store, specifications and stock", async () => {
    mockApi({
      "GET /api/v1/products/p1": () =>
        jsonResponse({
          product: {
            ...card(),
            slug: "galaxy-phone",
            description: "A good phone",
            category: { id: "c2", name: "Smartphones", slug: "smartphones" },
            vendor: { id: "s1", storeName: "Vikram Electronics", slug: "vikram-electronics" },
            images: [card().image],
            stock: 3,
            attributes: { RAM: "8 GB" },
            createdAt: "2026-11-01T00:00:00.000Z",
          },
        }),
    });
    renderWithProviders(<App />, { route: "/products/p1" });

    expect(await screen.findByRole("heading", { name: "Galaxy Phone" })).toBeInTheDocument();
    expect(screen.getByText("Only 3 left")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Vikram Electronics" })).toHaveAttribute("href", "/stores/vikram-electronics");
    expect(screen.getByText("RAM").nextSibling).toHaveTextContent("8 GB");
  });

  it("explains a missing product", async () => {
    mockApi({ "GET /api/v1/products/gone": () => errorResponse(404, "not_found") });
    renderWithProviders(<App />, { route: "/products/gone" });
    expect(await screen.findByRole("heading", { name: "Not found" })).toBeInTheDocument();
  });
});

const vendor = makeUser({ role: "vendor", name: "Vikram Vendor", email: "vendor@shopsphere.test" });

describe("vendor onboarding", () => {
  it("applies for a store and then shows that it's waiting for approval", async () => {
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(vendor),
      "POST /api/v1/vendors/apply": () => jsonResponse({ store: store() }, 201),
    });
    renderWithProviders(<App />, { route: "/vendor" });

    await userEvent.type(await screen.findByLabelText("Store name"), "Vikram Electronics");
    expect(screen.getByLabelText("Contact email")).toHaveValue("vendor@shopsphere.test");
    await userEvent.type(screen.getByLabelText("Mobile number"), "98765 43210");
    await userEvent.click(screen.getByRole("button", { name: "Submit application" }));

    expect(await screen.findByText("Your application is waiting for approval")).toBeInTheDocument();
    expect(bodyOf(spy, "POST", "/vendors/apply")).toMatchObject({ storeName: "Vikram Electronics", phone: "98765 43210" });
  });

  it("shows the API's message under each field", async () => {
    mockApi({
      "POST /api/v1/auth/refresh": () => session(vendor),
      "POST /api/v1/vendors/apply": () =>
        errorResponse(400, "validation_error", "Some fields need fixing", { fields: [{ field: "phone", message: "Enter a 10-digit Indian mobile number" }] }),
    });
    renderWithProviders(<App />, { route: "/vendor" });
    await userEvent.type(await screen.findByLabelText("Store name"), "Shop");
    await userEvent.click(screen.getByRole("button", { name: "Submit application" }));
    expect(await screen.findByText("Enter a 10-digit Indian mobile number")).toBeInTheDocument();
    expect(screen.getByLabelText("Mobile number")).toHaveAttribute("aria-invalid", "true");
  });

  it("tells a rejected vendor why and lets them apply again", async () => {
    mockApi({
      "POST /api/v1/auth/refresh": () => session(vendor),
      "GET /api/v1/vendors/me": () => jsonResponse({ store: store({ status: "rejected", rejectionReason: "Add a real description" }) }),
    });
    renderWithProviders(<App />, { route: "/vendor" });
    expect(await screen.findByText("Reason: Add a real description")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply again" })).toBeInTheDocument();
  });
});

describe("product editor", () => {
  const approved = () => ({
    "POST /api/v1/auth/refresh": () => session(vendor),
    "GET /api/v1/categories": () => jsonResponse({ items: categories }),
  });

  it("catches price mistakes before calling the API", async () => {
    const spy = mockApi(approved());
    renderWithProviders(<App />, { route: "/vendor/products/new" });

    await userEvent.type(await screen.findByLabelText("Title"), "Galaxy Phone");
    await userEvent.type(screen.getByLabelText("Selling price (₹)"), "1999");
    await userEvent.type(screen.getByLabelText("MRP (₹, optional)"), "999");
    await userEvent.click(screen.getByRole("button", { name: "Save as draft" }));

    expect(await screen.findByText("MRP can't be lower than the selling price")).toBeInTheDocument();
    expect(screen.getByText("Choose a category")).toBeInTheDocument();
    expect(screen.getByText("Enter how many you have, e.g. 25")).toBeInTheDocument();
    expect(spy.mock.calls.some(([url]) => String(url).endsWith("/vendor/products"))).toBe(false);
  });

  it("uploads a photo straight to storage and saves the product in paise with that photo", async () => {
    const spy = mockApi({
      ...approved(),
      "POST /api/v1/uploads/presign": () =>
        jsonResponse(
          {
            key: "products/s1/abc.png",
            uploadUrl: "http://storage.test/bucket/products/s1/abc.png?X-Amz-Signature=x",
            method: "PUT",
            headers: { "Content-Type": "image/png" },
            url: "http://storage.test/bucket/products/s1/abc.png",
          },
          201,
        ),
      "PUT /bucket/products/s1/abc.png": () => new Response(null, { status: 200 }),
      "POST /api/v1/vendor/products": () => jsonResponse({ product: {} }, 201),
    });
    renderWithProviders(<App />, { route: "/vendor/products/new" });

    await userEvent.upload(await screen.findByLabelText(/add photos/i), new File([new Uint8Array(2048)], "front.png", { type: "image/png" }));
    expect(await screen.findByAltText("Photo 1")).toHaveAttribute("src", "http://storage.test/bucket/products/s1/abc.png");
    expect(bodyOf(spy, "POST", "/uploads/presign")).toEqual({ purpose: "product-image", contentType: "image/png", size: 2048 });
    const put = spy.mock.calls.find(([, init]) => init?.method === "PUT")!;
    // Only the signed header goes to S3: no cookies, no API headers.
    expect(put[1]).toMatchObject({ headers: { "Content-Type": "image/png" } });
    expect(put[1]).not.toHaveProperty("credentials");

    await userEvent.type(screen.getByLabelText("Title"), "Galaxy Phone");
    await userEvent.selectOptions(screen.getByLabelText("Category"), "c2");
    await userEvent.type(screen.getByLabelText("Selling price (₹)"), "19,999");
    await userEvent.type(screen.getByLabelText("MRP (₹, optional)"), "24999");
    await userEvent.type(screen.getByLabelText("Stock"), "10");
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(bodyOf(spy, "POST", "/vendor/products")).toBeDefined());
    expect(bodyOf(spy, "POST", "/vendor/products")).toMatchObject({
      title: "Galaxy Phone",
      categoryId: "c2",
      price: 1_999_900,
      mrp: 2_499_900,
      stock: 10,
      status: "active",
      images: [{ key: "products/s1/abc.png", alt: "" }],
    });
  });

  it("refuses photos over 5 MB without uploading them", async () => {
    const spy = mockApi(approved());
    renderWithProviders(<App />, { route: "/vendor/products/new" });
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "huge.jpg", { type: "image/jpeg" });
    await userEvent.upload(await screen.findByLabelText(/add photos/i), big);
    expect(await screen.findByText("huge.jpg: photos must be 5 MB or smaller")).toBeInTheDocument();
    expect(spy.mock.calls.some(([url]) => String(url).endsWith("/uploads/presign"))).toBe(false);
  });
});

describe("admin vendor review", () => {
  const admin = makeUser({ role: "admin", name: "Asha Admin" });
  const listing = (items: unknown[]) =>
    jsonResponse({ items, page: 1, limit: 20, total: items.length, counts: { pending: items.length, approved: 0, rejected: 0, suspended: 0 } });

  it("approves an application", async () => {
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(admin),
      "GET /api/v1/admin/vendors": () => listing([{ ...store(), owner: { id: "u2", name: "Vikram", email: "v@x.test" }, productCount: 0 }]),
      "POST /api/v1/admin/vendors/s1/approve": () => jsonResponse({ store: store({ status: "approved" }) }),
    });
    renderWithProviders(<App />, { route: "/admin/vendors" });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).endsWith("/admin/vendors/s1/approve"))).toBe(true));
  });

  it("asks for a reason before rejecting and sends it", async () => {
    const spy = mockApi({
      "POST /api/v1/auth/refresh": () => session(admin),
      "GET /api/v1/admin/vendors": () => listing([{ ...store(), owner: null, productCount: 0 }]),
      "POST /api/v1/admin/vendors/s1/reject": () => jsonResponse({ store: store({ status: "rejected" }) }),
    });
    renderWithProviders(<App />, { route: "/admin/vendors" });
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText("Reason (the vendor will see this)"), "Please add your GSTIN");
    await userEvent.click(screen.getByRole("button", { name: "Reject application" }));
    await waitFor(() => expect(bodyOf(spy, "POST", "/admin/vendors/s1/reject")).toEqual({ reason: "Please add your GSTIN" }));
  });
});
