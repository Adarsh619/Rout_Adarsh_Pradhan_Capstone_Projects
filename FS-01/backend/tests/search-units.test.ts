import type { estypes } from "@elastic/elasticsearch";
import { describe, expect, it } from "vitest";
import { buildSearchRequest, buildSuggestRequest, searchParams, toSearchResponse } from "../src/modules/search/search-query.js";
import type { ProductSearchDoc } from "../src/modules/search/search-mapping.js";
import { memoryStorage } from "./helpers/memory-storage.js";

const parse = (query: Record<string, unknown>) => searchParams.parse(query);

describe("search parameters", () => {
  it("reads repeated brands, flags and numbers from the query string", () => {
    const p = parse({ q: " iphne ", brand: ["Apple", "Samsung"], inStock: "1", minPrice: "100000", rating: "4", page: "2" });
    expect(p).toMatchObject({ q: "iphne", brand: ["Apple", "Samsung"], inStock: true, minPrice: 100000, rating: 4, page: 2, limit: 20 });
    expect(parse({ brand: "Apple" }).brand).toEqual(["Apple"]);
  });

  it("refuses odd values", () => {
    expect(searchParams.safeParse({ sort: "cheapest" }).success).toBe(false);
    expect(searchParams.safeParse({ rating: "5" }).success).toBe(false);
    expect(searchParams.safeParse({ category: "<script>" }).success).toBe(false);
    expect(searchParams.safeParse({ limit: "500" }).success).toBe(false);
  });
});

describe("search request", () => {
  it("matches every word with typos allowed and boosts title matches", () => {
    const req = buildSearchRequest(parse({ q: "iphne" }), "products");
    const query = req.query as { bool: { must: estypes.QueryDslQueryContainer[]; should: estypes.QueryDslQueryContainer[] } };
    // A typo is allowed from 4 letters, two from 8 ("perfume" must not match "performance").
    expect(query.bool.must[0]!.multi_match).toMatchObject({ query: "iphne", operator: "and", fuzziness: "AUTO:4,8" });
    // Exact words outscore typo matches.
    expect(query.bool.should[0]!.multi_match).toMatchObject({ query: "iphne", boost: 3 });
    expect(query.bool.should[0]!.multi_match).not.toHaveProperty("fuzziness");
    expect(query.bool.should).toContainEqual({ match_phrase: { title: { query: "iphne", boost: 6 } } });
    expect(req.sort).toEqual(["_score", { ratingCount: "desc" }, { id: "asc" }]);
  });

  it("in relaxed mode needs only most of the words", () => {
    const req = buildSearchRequest(parse({ q: "red cotton dress" }), "products", true);
    const must = (req.query as { bool: { must: estypes.QueryDslQueryContainer[] } }).bool.must[0]!.multi_match;
    expect(must).toMatchObject({ operator: "or", minimum_should_match: "1<-1 4<75%" });
  });

  it("browses everything newest first when there are no search words", () => {
    const req = buildSearchRequest(parse({}), "products");
    expect(req.query).toEqual({ match_all: {} });
    expect(req.sort).toEqual([{ createdAt: "desc" }, { id: "asc" }]);
    expect(req.post_filter).toBeUndefined();
  });

  it("filters the results but counts each facet without its own filter", () => {
    const req = buildSearchRequest(parse({ brand: "Apple", maxPrice: "5000000", inStock: "true" }), "products");
    expect(req.post_filter).toEqual({
      bool: { filter: [{ terms: { brand: ["Apple"] } }, { range: { price: { lte: 5000000 } } }, { term: { inStock: true } }] },
    });
    // The brand facet ignores the brand filter (so other brands still show counts) but keeps the others.
    expect(req.aggs!.brands!.filter).toEqual({ bool: { filter: [{ range: { price: { lte: 5000000 } } }, { term: { inStock: true } }] } });
    expect(req.aggs!.categories!.filter).toEqual({
      bool: { filter: [{ terms: { brand: ["Apple"] } }, { range: { price: { lte: 5000000 } } }, { term: { inStock: true } }] },
    });
  });

  it("matches a department and its sub-categories", () => {
    const req = buildSearchRequest(parse({ category: "electronics" }), "products");
    expect(req.post_filter).toEqual({
      bool: { filter: [{ bool: { should: [{ term: { categorySlug: "electronics" } }, { term: { departmentSlug: "electronics" } }], minimum_should_match: 1 } }] },
    });
  });

  it("pages and sorts", () => {
    const req = buildSearchRequest(parse({ sort: "price_asc", page: "3", limit: "24" }), "products");
    expect(req).toMatchObject({ from: 48, size: 24, sort: [{ price: "asc" }, { id: "asc" }] });
  });

  it("autocompletes on word prefixes", () => {
    const req = buildSuggestRequest("gala", "products");
    expect(req.size).toBe(8);
    const should = (req.query as { bool: { should: estypes.QueryDslQueryContainer[] } }).bool.should;
    expect(should[0]!.multi_match).toMatchObject({ query: "gala", type: "bool_prefix", fields: ["suggest", "suggest._2gram", "suggest._3gram"] });
    expect(should[1]!.span_first).toMatchObject({ match: { span_multi: { match: { prefix: { title: { value: "gala" } } } } }, end: 1 });
    expect(should[2]!.match).toMatchObject({ suggest: { query: "gala", fuzziness: "AUTO" } });
    // The prefix is folded the way the index stores titles.
    const folded = (buildSuggestRequest("Café Noir", "products").query as { bool: { should: estypes.QueryDslQueryContainer[] } }).bool.should[1]!;
    expect(folded.span_first!.match).toEqual({ span_multi: { match: { prefix: { title: { value: "cafe" } } } } });
  });
});

describe("search response", () => {
  it("turns hits and aggregations into cards and named facets", () => {
    const doc = {
      id: "p1",
      title: "iPhone 13",
      brand: "Apple",
      vendorName: "Vikram Electronics",
      vendorSlug: "vikram-electronics",
      price: 6_999_900,
      mrp: 7_999_900,
      discountPercent: 13,
      ratingAvg: 4.5,
      ratingCount: 10,
      inStock: true,
      imageKey: "products/v1/a.webp",
      imageAlt: "iPhone 13",
    } as ProductSearchDoc;
    const res = {
      took: 3,
      timed_out: false,
      _shards: { total: 1, successful: 1, failed: 0 },
      hits: { total: { value: 1, relation: "eq" }, hits: [{ _index: "products", _id: "p1", _source: doc }] },
      aggregations: {
        categories: { values: { buckets: [{ key: "smartphones|Smartphones", doc_count: 1 }] } },
        brands: { values: { buckets: [{ key: "Apple", doc_count: 1 }] } },
        vendors: { values: { buckets: [{ key: "vikram-electronics|Vikram Electronics", doc_count: 1 }] } },
        price: { values: { buckets: [{ key: "20000-plus", from: 2_000_000, doc_count: 1 }, { key: "under-500", to: 50_000, doc_count: 0 }] } },
        rating: { values: { buckets: [{ key: "4", from: 4, doc_count: 1 }, { key: "3", from: 3, doc_count: 1 }, { key: "2", from: 2, doc_count: 1 }] } },
        inStock: { values: { doc_count: 1 } },
      },
    } as unknown as estypes.SearchResponse<ProductSearchDoc>;

    const out = toSearchResponse(res, parse({}), memoryStorage());
    expect(out.items[0]).toMatchObject({ id: "p1", image: { url: "http://storage.test/bucket/products/v1/a.webp" }, vendor: { slug: "vikram-electronics" } });
    expect(out.total).toBe(1);
    expect(out.facets).toEqual({
      categories: [{ slug: "smartphones", name: "Smartphones", count: 1 }],
      brands: [{ value: "Apple", count: 1 }],
      vendors: [{ slug: "vikram-electronics", name: "Vikram Electronics", count: 1 }],
      price: [{ key: "20000-plus", min: 2_000_000, max: null, count: 1 }],
      rating: [
        { min: 4, count: 1 },
        { min: 3, count: 1 },
        { min: 2, count: 1 },
      ],
      inStock: 1,
    });
  });
});
