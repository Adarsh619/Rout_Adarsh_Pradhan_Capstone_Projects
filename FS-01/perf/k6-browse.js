// Load test: shoppers browsing the live site (read-only; creates no data).
//   docker run --rm -i -v "$PWD/perf:/perf" grafana/k6:0.57.0 run /perf/k6-browse.js
//   BASE_URL=http://localhost:3001 ... to aim at the local stack instead.
// Each virtual user loops: categories → a search (sometimes filtered/sorted) → suggestions → a product page →
// its reviews → sometimes a store page, with a 1–3 s pause between steps like a person reading.
// Load: ramps to 20 users, holds, ramps to 50, holds, ramps down (~4 min).
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "https://shopsphere-adarsh.duckdns.org").replace(/\/$/, "") + "/api/v1";
const TERMS = ["phone", "nike", "laptop", "watch", "shirt", "shoes", "perfume", "bag", "sofa", "lipstick", "samsung", "apple"];
const SORTS = ["price_asc", "price_desc", "rating", "newest"];

// Product page time split by Redis cache result (X-Cache: HIT / MISS).
const productHit = new Trend("product_page_cache_hit", true);
const productMiss = new Trend("product_page_cache_miss", true);

export const options = {
  stages: [
    { duration: "30s", target: 20 },
    { duration: "1m", target: 20 },
    { duration: "30s", target: 50 },
    { duration: "1m", target: 50 },
    { duration: "20s", target: 0 },
  ],
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
    "http_req_duration{endpoint:search}": ["p(95)<800"],
    "http_req_duration{endpoint:product}": ["p(95)<500"],
  },
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "max"],
};

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const get = (path, endpoint) => http.get(`${BASE}${path}`, { tags: { endpoint } });

// Product ids and store slugs to visit, collected once before the test.
export function setup() {
  const products = new Set();
  const stores = new Set();
  for (const term of TERMS) {
    const res = http.get(`${BASE}/search?q=${term}&limit=24`);
    if (res.status !== 200) continue;
    for (const item of res.json("items") || []) {
      products.add(item.id);
      if (item.vendor && item.vendor.slug) stores.add(item.vendor.slug);
    }
  }
  if (products.size === 0) throw new Error(`no products found at ${BASE}`);
  return { products: [...products], stores: [...stores] };
}

export default function (data) {
  group("browse", () => {
    check(get("/categories", "categories"), { "categories 200": (r) => r.status === 200 });
    sleep(1 + Math.random());

    let q = `/search?q=${pick(TERMS)}`;
    if (Math.random() < 0.4) q += `&sort=${pick(SORTS)}`;
    if (Math.random() < 0.3) q += "&inStock=true&minPrice=50000";
    check(get(q, "search"), { "search 200": (r) => r.status === 200 });

    check(get(`/search/suggest?q=${pick(TERMS).slice(0, 3)}`, "suggest"), { "suggest 200": (r) => r.status === 200 });
    sleep(1 + Math.random() * 2);

    const id = pick(data.products);
    const product = get(`/products/${id}`, "product");
    check(product, { "product 200": (r) => r.status === 200 });
    (product.headers["X-Cache"] === "HIT" ? productHit : productMiss).add(product.timings.duration);
    check(get(`/products/${id}/reviews`, "reviews"), { "reviews 200": (r) => r.status === 200 });
    sleep(1 + Math.random() * 2);

    if (Math.random() < 0.3 && data.stores.length) {
      check(get(`/stores/${pick(data.stores)}`, "store"), { "store 200": (r) => r.status === 200 });
      sleep(1);
    }
  });
}
