import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { SEARCH_SORT_LABELS, useSearch, type SearchFacets, type SearchFilters, type SearchSort } from "../api/search";
import { LoadError, Loading, Pagination, ProductGrid } from "../components/Catalog";
import { formatINR } from "../lib/money";

// Every choice lives in the URL (prices in rupees, so links read naturally: /search?q=phone&maxPrice=20000),
// which makes a search shareable, bookmarkable and survive a reload or the back button.
function filtersFrom(params: URLSearchParams): SearchFilters {
  const num = (k: string) => {
    const v = Number(params.get(k));
    return params.has(k) && Number.isFinite(v) && v >= 0 ? v : undefined;
  };
  const rupees = (k: string) => (num(k) === undefined ? undefined : Math.round(num(k)! * 100));
  return {
    q: params.get("q")?.trim() || undefined,
    category: params.get("category") ?? undefined,
    brand: params.getAll("brand"),
    vendor: params.get("vendor") ?? undefined,
    minPrice: rupees("minPrice"),
    maxPrice: rupees("maxPrice"),
    rating: num("rating"),
    inStock: params.get("inStock") === "1" || undefined,
    sort: (params.get("sort") as SearchSort | null) ?? undefined,
    page: num("page") ?? 1,
  };
}

const PRICE_LABELS: Record<string, string> = {
  "under-500": "Under ₹500",
  "500-1000": "₹500 – ₹1,000",
  "1000-5000": "₹1,000 – ₹5,000",
  "5000-20000": "₹5,000 – ₹20,000",
  "20000-plus": "Over ₹20,000",
};

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-1.5 border-t border-slate-200 pt-4">
      <legend className="mb-1 text-sm font-semibold">{title}</legend>
      {children}
    </fieldset>
  );
}

function Option({ type, checked, onChange, label, count }: { type: "checkbox" | "radio"; checked: boolean; onChange: () => void; label: string; count: number }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-sm">
      <span className="flex items-center gap-2">
        <input type={type} checked={checked} onChange={onChange} className="accent-brand-600" />
        {label}
      </span>
      <span className="text-xs text-slate-500">{count}</span>
    </label>
  );
}

function Filters({ facets, f, set }: { facets: SearchFacets; f: SearchFilters; set: (changes: Record<string, string | string[] | undefined>) => void }) {
  const [min, setMin] = useState(f.minPrice !== undefined ? String(f.minPrice / 100) : "");
  const [max, setMax] = useState(f.maxPrice !== undefined ? String(f.maxPrice / 100) : "");
  const brands = f.brand ?? [];

  return (
    <div className="space-y-4">
      {facets.categories.length > 0 && (
        <Group title="Category">
          {f.category && (
            <button type="button" onClick={() => set({ category: undefined })} className="text-xs text-brand-700 underline">
              All categories
            </button>
          )}
          {facets.categories.map((c) => (
            <Option key={c.slug} type="radio" checked={f.category === c.slug} onChange={() => set({ category: c.slug })} label={c.name} count={c.count} />
          ))}
        </Group>
      )}

      <Group title="Price">
        {facets.price.map((p) => {
          const checked = f.minPrice === (p.min ?? undefined) && f.maxPrice === (p.max ?? undefined);
          return (
            <Option
              key={p.key}
              type="radio"
              checked={checked}
              onChange={() => set({ minPrice: p.min === null ? undefined : String(p.min / 100), maxPrice: p.max === null ? undefined : String(p.max / 100) })}
              label={PRICE_LABELS[p.key] ?? p.key}
              count={p.count}
            />
          );
        })}
        <form
          className="flex items-center gap-1 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            set({ minPrice: min.trim() || undefined, maxPrice: max.trim() || undefined });
          }}
        >
          <input aria-label="Minimum price in rupees" inputMode="numeric" placeholder="₹ Min" value={min} onChange={(e) => setMin(e.target.value.replace(/\D/g, ""))} className="w-20 rounded border border-slate-300 px-2 py-1 text-sm" />
          <span className="text-slate-400">–</span>
          <input aria-label="Maximum price in rupees" inputMode="numeric" placeholder="₹ Max" value={max} onChange={(e) => setMax(e.target.value.replace(/\D/g, ""))} className="w-20 rounded border border-slate-300 px-2 py-1 text-sm" />
          <button type="submit" className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50">
            Go
          </button>
        </form>
      </Group>

      {facets.brands.length > 0 && (
        <Group title="Brand">
          {facets.brands.map((b) => (
            <Option
              key={b.value}
              type="checkbox"
              checked={brands.includes(b.value)}
              onChange={() => set({ brand: brands.includes(b.value) ? brands.filter((x) => x !== b.value) : [...brands, b.value] })}
              label={b.value}
              count={b.count}
            />
          ))}
        </Group>
      )}

      {facets.rating.length > 0 && (
        <Group title="Customer rating">
          {facets.rating.map((r) => (
            <Option key={r.min} type="radio" checked={f.rating === r.min} onChange={() => set({ rating: String(r.min) })} label={`${r.min}★ & up`} count={r.count} />
          ))}
        </Group>
      )}

      <Group title="Availability">
        <Option type="checkbox" checked={Boolean(f.inStock)} onChange={() => set({ inStock: f.inStock ? undefined : "1" })} label="In stock only" count={facets.inStock} />
      </Group>

      {facets.vendors.length > 0 && (
        <Group title="Store">
          {facets.vendors.map((v) => (
            <Option key={v.slug} type="radio" checked={f.vendor === v.slug} onChange={() => set({ vendor: v.slug })} label={v.name} count={v.count} />
          ))}
        </Group>
      )}
    </div>
  );
}

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const f = filtersFrom(params);
  const search = useSearch(f);
  const [showFilters, setShowFilters] = useState(false);

  // Any change but paging goes back to page 1.
  const set = (changes: Record<string, string | string[] | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      next.delete(k);
      for (const value of Array.isArray(v) ? v : v === undefined ? [] : [v]) next.append(k, value);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  };

  // Chips for the active filters, each removable on its own.
  const chips: { label: string; clear: Record<string, string | string[] | undefined> }[] = [
    ...(f.category ? [{ label: search.data?.facets.categories.find((c) => c.slug === f.category)?.name ?? f.category, clear: { category: undefined } }] : []),
    ...(f.brand ?? []).map((b) => ({ label: b, clear: { brand: (f.brand ?? []).filter((x) => x !== b) } })),
    ...(f.minPrice !== undefined || f.maxPrice !== undefined
      ? [{ label: `${f.minPrice !== undefined ? formatINR(f.minPrice) : "₹0"} – ${f.maxPrice !== undefined ? formatINR(f.maxPrice) : "any"}`, clear: { minPrice: undefined, maxPrice: undefined } }]
      : []),
    ...(f.rating ? [{ label: `${f.rating}★ & up`, clear: { rating: undefined } }] : []),
    ...(f.inStock ? [{ label: "In stock", clear: { inStock: undefined } }] : []),
    ...(f.vendor ? [{ label: search.data?.facets.vendors.find((v) => v.slug === f.vendor)?.name ?? f.vendor, clear: { vendor: undefined } }] : []),
  ];

  const sort = f.sort ?? (f.q ? "relevance" : "newest");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{f.q ? <>Results for “{f.q}”</> : "All products"}</h1>
          {search.data && (
            <p className="mt-1 text-sm text-slate-600" role="status">
              {search.data.total.toLocaleString("en-IN")} {search.data.total === 1 ? "product" : "products"}
              {!search.data.matchedAllWords && " matching some of your words"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setShowFilters((s) => !s)} aria-expanded={showFilters} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm lg:hidden">
            Filters{chips.length ? ` (${chips.length})` : ""}
          </button>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            Sort by
            <select value={sort} onChange={(e) => set({ sort: e.target.value })} className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900">
              {Object.entries(SEARCH_SORT_LABELS)
                .filter(([v]) => f.q || v !== "relevance")
                .map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
            </select>
          </label>
        </div>
      </div>

      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Active filters">
          {chips.map((c) => (
            <li key={c.label}>
              <button type="button" onClick={() => set(c.clear)} className="rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-700 hover:bg-brand-100" aria-label={`Remove filter ${c.label}`}>
                {c.label} <span aria-hidden="true">×</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" onClick={() => setParams(f.q ? { q: f.q } : {})} className="px-2 py-1 text-sm text-slate-600 underline">
              Clear all
            </button>
          </li>
        </ul>
      )}

      <div className="grid gap-8 lg:grid-cols-[15rem_1fr]">
        <aside aria-label="Filters" className={`${showFilters ? "block" : "hidden"} lg:block`}>
          {search.data && <Filters key={`${f.minPrice}-${f.maxPrice}`} facets={search.data.facets} f={f} set={set} />}
        </aside>
        <section aria-label="Results" className="space-y-6">
          {search.isPending ? (
            <Loading text="Searching…" />
          ) : search.isError ? (
            <LoadError error={search.error} />
          ) : (
            <>
              <ProductGrid page={search.data} emptyText={f.q ? `Nothing matches “${f.q}”. Try fewer words or check the spelling.` : "No products match these filters."} />
              <Pagination page={search.data} onPage={(n) => set({ page: String(n) })} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
