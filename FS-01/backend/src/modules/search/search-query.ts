import type { estypes } from "@elastic/elasticsearch";
import { z } from "zod";
import type { Storage } from "../../lib/s3.js";
import { pageQuery } from "../../middleware/validate.js";
import type { ProductSearchDoc } from "./search-mapping.js";

// Turns the shop's search parameters into one Elasticsearch request, and its answer into the API's response.
// Pure functions, so the query rules are unit-tested without Elasticsearch.

const SORTS = ["relevance", "newest", "price_asc", "price_desc", "rating"] as const;
export type SearchSort = (typeof SORTS)[number];

const slug = z.string().trim().toLowerCase().max(80).regex(/^[a-z0-9-]+$/, "Invalid value");
const paise = z.coerce.number().int().min(0).max(1_000_000_000);
const flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

export const searchParams = pageQuery.extend({
  q: z.string().trim().max(100).optional(),
  category: slug.optional(),
  // ?brand=Apple&brand=Samsung (any of them).
  brand: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]).map((b) => b.trim()).filter(Boolean))
    .pipe(z.array(z.string().max(60)).max(20))
    .optional(),
  vendor: slug.optional(),
  minPrice: paise.optional(),
  maxPrice: paise.optional(),
  rating: z.coerce.number().int().min(1).max(4).optional(),
  inStock: flag.optional(),
  sort: z.enum(SORTS).optional(),
});
export type SearchParams = z.infer<typeof searchParams>;

export const suggestParams = z.object({ q: z.string().trim().min(2).max(100) });

// Price filter buckets shown with counts, in paise.
export const PRICE_BUCKETS = [
  { key: "under-500", to: 50_000 },
  { key: "500-1000", from: 50_000, to: 100_000 },
  { key: "1000-5000", from: 100_000, to: 500_000 },
  { key: "5000-20000", from: 500_000, to: 2_000_000 },
  { key: "20000-plus", from: 2_000_000 },
];

type Query = estypes.QueryDslQueryContainer;
type FilterName = "category" | "brand" | "vendor" | "price" | "rating" | "inStock";

function filtersOf(p: SearchParams): Partial<Record<FilterName, Query>> {
  const f: Partial<Record<FilterName, Query>> = {};
  // A department slug matches all of its sub-categories.
  if (p.category) {
    f.category = { bool: { should: [{ term: { categorySlug: p.category } }, { term: { departmentSlug: p.category } }], minimum_should_match: 1 } };
  }
  if (p.brand?.length) f.brand = { terms: { brand: p.brand } };
  if (p.vendor) f.vendor = { term: { vendorSlug: p.vendor } };
  if (p.minPrice !== undefined || p.maxPrice !== undefined) {
    f.price = { range: { price: { ...(p.minPrice !== undefined && { gte: p.minPrice }), ...(p.maxPrice !== undefined && { lte: p.maxPrice }) } } };
  }
  if (p.rating) f.rating = { range: { ratingAvg: { gte: p.rating } } };
  if (p.inStock) f.inStock = { term: { inStock: true } };
  return f;
}

// Every word must appear (in the title, brand, category or store name, or all of them in the description), allowing
// a typo in words of 4+ letters and two in words of 8+ ("iphne" → "iphone"). Exact words score above typo matches,
// title matches highest, an exact phrase in the title higher still.
// relaxed: when no product has every word, all but one word is enough (three-quarters from five words up), so
// "red dress" still shows dresses.
function textQuery(q: string, relaxed: boolean): Query {
  const fuzzy = { fuzziness: "AUTO:4,8", prefix_length: 1 };
  const words = relaxed ? { operator: "or" as const, minimum_should_match: "1<-1 4<75%" } : { operator: "and" as const };
  return {
    bool: {
      must: [{ multi_match: { query: q, fields: ["searchText", "description"], type: "best_fields", ...words, ...fuzzy } }],
      should: [
        { multi_match: { query: q, fields: ["searchText^2", "description"], type: "best_fields", boost: 3 } },
        { match: { title: { query: q, boost: 4, ...fuzzy } } },
        { match: { "title.stem": { query: q, boost: 2 } } },
        { match_phrase: { title: { query: q, boost: 6 } } },
        { match: { "brand.text": { query: q, boost: 3, ...fuzzy } } },
      ],
    },
  };
}

function sortOf(sort: SearchSort, hasText: boolean): estypes.Sort {
  switch (sort) {
    case "price_asc":
      return [{ price: "asc" }, { id: "asc" }];
    case "price_desc":
      return [{ price: "desc" }, { id: "asc" }];
    case "rating":
      return [{ ratingAvg: "desc" }, { ratingCount: "desc" }, { id: "asc" }];
    case "newest":
      return [{ createdAt: "desc" }, { id: "asc" }];
    default:
      // Relevance only means something with search words; otherwise newest first.
      return hasText ? ["_score", { ratingCount: "desc" }, { id: "asc" }] : [{ createdAt: "desc" }, { id: "asc" }];
  }
}

// Filters go in post_filter, and each facet counts with every filter except its own. So ticking "Apple" narrows the
// results and the other facets, but the brand list still shows how many Samsung products there are (to add them).
export function buildSearchRequest(p: SearchParams, index: string, relaxed = false): estypes.SearchRequest {
  const filters = filtersOf(p);
  const all = Object.values(filters);
  const except = (name: FilterName): Query => ({ bool: { filter: Object.entries(filters).filter(([k]) => k !== name).map(([, q]) => q) } });
  const facet = (name: FilterName, agg: Record<string, estypes.AggregationsAggregationContainer>) => ({ filter: except(name), aggs: agg });
  const sort = p.sort ?? "relevance";

  return {
    index,
    from: (p.page - 1) * p.limit,
    size: p.limit,
    track_total_hits: true,
    query: p.q ? textQuery(p.q, relaxed) : { match_all: {} },
    ...(all.length && { post_filter: { bool: { filter: all } } }),
    sort: sortOf(sort, Boolean(p.q)),
    _source: { excludes: ["description", "suggest"] },
    aggs: {
      categories: facet("category", { values: { terms: { field: "categoryFacet", size: 50 } } }),
      brands: facet("brand", { values: { terms: { field: "brand", size: 30 } } }),
      vendors: facet("vendor", { values: { terms: { field: "vendorFacet", size: 30 } } }),
      price: facet("price", { values: { range: { field: "price", ranges: PRICE_BUCKETS } } }),
      rating: facet("rating", { values: { range: { field: "ratingAvg", ranges: [4, 3, 2].map((n) => ({ key: String(n), from: n })) } } }),
      inStock: facet("inStock", { values: { filter: { term: { inStock: true } } } }),
    },
  };
}

// The first word as the index stores it (lower-case, accents removed), for prefix matching.
const firstWord = (q: string) =>
  (q.trim().split(/\s+/)[0] ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

export function buildSuggestRequest(q: string, index: string): estypes.SearchRequest {
  return {
    index,
    size: 8,
    _source: ["id", "title"],
    query: {
      bool: {
        should: [
            // "gal" → Galaxy: the last word is treated as the start of a word.
          { multi_match: { query: q, type: "bool_prefix", fields: ["suggest", "suggest._2gram", "suggest._3gram"] } },
          // Titles that start with what was typed come first ("lapt" → "Laptop …" before "… Fits 15 Laptops").
          { span_first: { match: { span_multi: { match: { prefix: { title: { value: firstWord(q) } } } } }, end: 1, boost: 3 } },
          // "macbok" → MacBook: Elasticsearch doesn't allow typos in that last, partial word, so whole words are
          // also matched with typos allowed.
          { match: { suggest: { query: q, fuzziness: "AUTO", prefix_length: 1, operator: "and" } } },
        ],
      },
    },
  };
}

interface Bucket {
  key: string | number;
  doc_count: number;
}
const bucketsOf = (aggs: Record<string, unknown> | undefined, name: string): Bucket[] =>
  ((aggs?.[name] as { values?: { buckets?: Bucket[] } } | undefined)?.values?.buckets ?? []).filter((b) => b.doc_count > 0);
const splitFacet = (b: Bucket) => {
  const [slugValue, ...name] = String(b.key).split("|");
  return { slug: slugValue!, name: name.join("|"), count: b.doc_count };
};

export function toSearchResponse(res: estypes.SearchResponse<ProductSearchDoc>, p: SearchParams, storage: Storage) {
  const aggs = res.aggregations as Record<string, unknown> | undefined;
  const total = typeof res.hits.total === "number" ? res.hits.total : (res.hits.total?.value ?? 0);
  const ratingBuckets = ((aggs?.rating as { values?: { buckets?: Bucket[] } })?.values?.buckets ?? []) as Bucket[];
  return {
    items: res.hits.hits.map((h) => {
      const d = h._source!;
      return {
        id: d.id,
        title: d.title,
        brand: d.brand,
        image: d.imageKey ? { url: storage.publicUrl(d.imageKey), alt: d.imageAlt } : null,
        price: d.price,
        mrp: d.mrp,
        discountPercent: d.discountPercent,
        inStock: d.inStock,
        ratingAvg: d.ratingAvg,
        ratingCount: d.ratingCount,
        vendor: { storeName: d.vendorName, slug: d.vendorSlug },
      };
    }),
    page: p.page,
    limit: p.limit,
    total,
    facets: {
      categories: bucketsOf(aggs, "categories").map(splitFacet),
      brands: bucketsOf(aggs, "brands").map((b) => ({ value: String(b.key), count: b.doc_count })),
      vendors: bucketsOf(aggs, "vendors").map(splitFacet),
      price: bucketsOf(aggs, "price").map((b) => {
        const bucket = PRICE_BUCKETS.find((x) => x.key === b.key)!;
        return { key: String(b.key), min: bucket.from ?? null, max: bucket.to ?? null, count: b.doc_count };
      }),
      rating: ratingBuckets.filter((b) => b.doc_count > 0).map((b) => ({ min: Number(b.key), count: b.doc_count })),
      inStock: (aggs?.inStock as { values?: { doc_count?: number } })?.values?.doc_count ?? 0,
    },
  };
}
