import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { ProductCard } from "../api/catalog";
import type { SearchResult } from "../api/search";
import { jsonResponse, mockApi, renderWithProviders } from "../test/render";

const card = (id: string, title: string, brand: string): ProductCard => ({
  id,
  title,
  brand,
  image: null,
  price: 1_999_900,
  mrp: 1_999_900,
  discountPercent: 0,
  inStock: true,
  ratingAvg: 4,
  ratingCount: 3,
  vendor: { storeName: "Vikram Electronics", slug: "vikram-electronics" },
});

const result = (overrides: Partial<SearchResult> = {}): SearchResult => ({
  items: [card("p1", "iPhone 13", "Apple")],
  page: 1,
  limit: 24,
  total: 1,
  matchedAllWords: true,
  tookMs: 4,
  facets: {
    categories: [{ slug: "smartphones", name: "Smartphones", count: 3 }],
    brands: [
      { value: "Apple", count: 1 },
      { value: "Samsung", count: 2 },
    ],
    vendors: [{ slug: "vikram-electronics", name: "Vikram Electronics", count: 3 }],
    price: [{ key: "20000-plus", min: 2_000_000, max: null, count: 3 }],
    rating: [{ min: 4, count: 2 }],
    inStock: 3,
  },
  ...overrides,
});

const searchCalls = (spy: ReturnType<typeof mockApi>) =>
  spy.mock.calls.map(([url]) => new URL(String(url), "http://localhost")).filter((u) => u.pathname === "/api/v1/search");

describe("search page", () => {
  it("reads the search from the URL, with prices in rupees, and shows results with filter counts", async () => {
    const spy = mockApi({ "GET /api/v1/search": () => jsonResponse(result()) });
    renderWithProviders(<App />, { route: "/search?q=phone&brand=Apple&maxPrice=20000" });

    expect(await screen.findByRole("heading", { name: "Results for “phone”" })).toBeInTheDocument();
    expect(await screen.findByText("iPhone 13")).toBeInTheDocument();
    const call = searchCalls(spy)[0]!;
    expect(call.searchParams.get("q")).toBe("phone");
    expect(call.searchParams.getAll("brand")).toEqual(["Apple"]);
    expect(call.searchParams.get("maxPrice")).toBe("2000000");

    const filters = screen.getByRole("complementary", { name: "Filters" });
    expect(within(filters).getByRole("checkbox", { name: /Apple/ })).toBeChecked();
    expect(within(filters).getByText("Samsung").closest("label")).toHaveTextContent("2");
    // The header search box shows the current search.
    expect(screen.getByRole("combobox", { name: "Search products" })).toHaveValue("phone");
  });

  it("adds a brand to the filter and removes filters with their chips", async () => {
    const spy = mockApi({ "GET /api/v1/search": () => jsonResponse(result()) });
    renderWithProviders(<App />, { route: "/search?q=phone&brand=Apple" });

    await userEvent.click(await screen.findByRole("checkbox", { name: /Samsung/ }));
    await waitFor(() => expect(searchCalls(spy).at(-1)!.searchParams.getAll("brand")).toEqual(["Apple", "Samsung"]));

    await userEvent.click(screen.getByRole("button", { name: "Remove filter Apple" }));
    await waitFor(() => expect(searchCalls(spy).at(-1)!.searchParams.getAll("brand")).toEqual(["Samsung"]));
    expect(searchCalls(spy).at(-1)!.searchParams.get("q")).toBe("phone");
  });

  it("says when only some of the words matched", async () => {
    mockApi({ "GET /api/v1/search": () => jsonResponse(result({ matchedAllWords: false, total: 17 })) });
    renderWithProviders(<App />, { route: "/search?q=red%20dress" });
    expect(await screen.findByText("17 products matching some of your words")).toBeInTheDocument();
  });

  it("explains an empty result", async () => {
    mockApi({ "GET /api/v1/search": () => jsonResponse(result({ items: [], total: 0 })) });
    renderWithProviders(<App />, { route: "/search?q=unicorn" });
    expect(await screen.findByText("Nothing matches “unicorn”. Try fewer words or check the spelling.")).toBeInTheDocument();
  });
});

describe("header search box", () => {
  it("searches on Enter", async () => {
    const spy = mockApi({
      "GET /api/v1/search/suggest": () => jsonResponse({ items: [] }),
      "GET /api/v1/search": () => jsonResponse(result()),
    });
    renderWithProviders(<App />, { route: "/" });
    await userEvent.type(screen.getByRole("combobox", { name: "Search products" }), "iphne{Enter}");
    expect(await screen.findByRole("heading", { name: "Results for “iphne”" })).toBeInTheDocument();
    expect(searchCalls(spy)[0]!.searchParams.get("q")).toBe("iphne");
  });

  it("suggests titles while typing and opens the chosen product with the keyboard", async () => {
    mockApi({
      "GET /api/v1/search/suggest": () => jsonResponse({ items: [{ id: "p2", title: "Galaxy S24" }, { id: "p3", title: "Galaxy Tab" }] }),
      "GET /api/v1/products/p3": () => jsonResponse({ product: { ...card("p3", "Galaxy Tab", "Samsung"), images: [], description: "", category: null, slug: "galaxy-tab", stock: 3, attributes: {}, createdAt: "2026-11-01T00:00:00.000Z", vendor: { id: "s1", storeName: "Vikram Electronics", slug: "vikram-electronics" } } }),
    });
    renderWithProviders(<App />, { route: "/" });
    const box = screen.getByRole("combobox", { name: "Search products" });
    await userEvent.type(box, "gal");

    const options = await within(screen.getByRole("listbox", { name: "Suggestions" })).findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Galaxy S24", "Galaxy Tab"]);
    expect(box).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("heading", { name: "Galaxy Tab" })).toBeInTheDocument();
  });
});
