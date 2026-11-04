import { useSearchParams } from "react-router";
import { useCategories, useProducts, type Sort } from "../api/catalog";
import { LoadError, Loading, Pagination, ProductGrid, SortSelect } from "../components/Catalog";
import { SystemStatus } from "../components/SystemStatus";

// Browse by department and sort; the choice lives in the URL so it can be shared and survives a reload.
// Full-text search with filters arrives with Elasticsearch on Day 4.
export function HomePage() {
  const [params, setParams] = useSearchParams();
  const category = params.get("category") ?? undefined;
  const sort = (params.get("sort") as Sort | null) ?? "newest";
  const page = Number(params.get("page") ?? 1) || 1;
  const categories = useCategories();
  const products = useProducts({ category, sort, page, limit: 24 });

  const update = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  };

  const departments = categories.data ?? [];
  const current = departments.flatMap((d) => [d, ...d.children]).find((c) => c.slug === category);
  // The department the chosen category belongs to (itself, for a department), whose sub-categories are offered.
  const department = departments.find((d) => d.slug === category || d.children.some((c) => c.slug === category));

  return (
    <div className="space-y-8">
      {!category && (
        <section className="rounded-2xl bg-brand-900 px-8 py-10 text-white">
          <p className="text-sm font-medium uppercase tracking-wide text-brand-100">Multi-vendor marketplace</p>
          <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Many sellers. One cart. One checkout.</h1>
          <p className="mt-3 max-w-2xl text-brand-100">
            Shop from independent stores in one place. ShopSphere splits every payment between the sellers in your order.
          </p>
        </section>
      )}

      <nav aria-label="Departments" className="flex flex-wrap gap-2">
        <Chip active={!category} onClick={() => update({ category: undefined })}>
          All
        </Chip>
        {departments.map((d) => (
          <Chip key={d.id} active={department?.id === d.id} onClick={() => update({ category: d.slug })}>
            {d.name}
          </Chip>
        ))}
      </nav>

      {department && department.children.length > 1 && (
        <nav aria-label={`${department.name} categories`} className="-mt-4 flex flex-wrap gap-2">
          {department.children.map((c) => (
            <Chip key={c.id} small active={c.slug === category} onClick={() => update({ category: c.slug })}>
              {c.name}
            </Chip>
          ))}
        </nav>
      )}

      <section aria-labelledby="products-heading" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="products-heading" className="text-xl font-semibold">
            {current ? current.name : "All products"}
            {products.data && <span className="ml-2 text-sm font-normal text-slate-500">{products.data.total.toLocaleString("en-IN")} items</span>}
          </h2>
          <SortSelect value={sort} onChange={(s) => update({ sort: s === "newest" ? undefined : s })} />
        </div>
        {products.isPending ? (
          <Loading text="Loading products…" />
        ) : products.isError ? (
          <LoadError error={products.error} />
        ) : (
          <>
            <ProductGrid page={products.data} emptyText="No products here yet." />
            <Pagination page={products.data} onPage={(n) => update({ page: String(n) })} />
          </>
        )}
      </section>

      {!category && <SystemStatus />}
    </div>
  );
}

function Chip({ active, small, onClick, children }: { active: boolean; small?: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border ${small ? "px-3 py-1 text-xs" : "px-4 py-1.5 text-sm"} ${
        active ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:border-brand-600"
      }`}
    >
      {children}
    </button>
  );
}
