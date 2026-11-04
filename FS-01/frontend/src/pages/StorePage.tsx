import { useParams, useSearchParams } from "react-router";
import { useStore, type Sort } from "../api/catalog";
import { LoadError, Loading, Pagination, ProductGrid, Rating, SortSelect } from "../components/Catalog";

export function StorePage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const sort = (params.get("sort") as Sort | null) ?? "newest";
  const page = Number(params.get("page") ?? 1) || 1;
  const { data, isPending, isError, error } = useStore(slug, { sort, page, limit: 24 });

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;
  const { store, products } = data;

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-center gap-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-xl bg-brand-50 text-3xl font-bold text-brand-700">
          {store.logoUrl ? <img src={store.logoUrl} alt="" className="h-full w-full object-cover" /> : store.storeName.charAt(0)}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold">{store.storeName}</h1>
          {store.description && <p className="mt-1 text-slate-600">{store.description}</p>}
          <p className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-500">
            <Rating avg={store.ratingAvg} count={store.ratingCount} />
            <span>Selling on ShopSphere since {new Date(store.since).toLocaleDateString("en-IN", { month: "long", year: "numeric" })}</span>
          </p>
        </div>
      </header>

      <section aria-labelledby="store-products" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="store-products" className="text-xl font-semibold">
            Products <span className="text-sm font-normal text-slate-500">{products.total.toLocaleString("en-IN")} items</span>
          </h2>
          <SortSelect value={sort} onChange={(s) => setParams(s === "newest" ? {} : { sort: s })} />
        </div>
        <ProductGrid page={products} showStore={false} emptyText="This store hasn't listed any products yet." />
        <Pagination
          page={products}
          onPage={(n) => {
            const next = new URLSearchParams(params);
            next.set("page", String(n));
            setParams(next);
          }}
        />
      </section>
    </div>
  );
}
