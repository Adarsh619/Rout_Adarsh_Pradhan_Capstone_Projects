import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { ProductStatus, VendorProduct } from "../../api/catalog";
import { ApiError } from "../../api/client";
import { deleteProduct, useMyProducts } from "../../api/vendor";
import { LoadError, Loading, Pagination, StatusBadge } from "../../components/Catalog";
import { FormError } from "../../components/Field";
import { formatINR } from "../../lib/money";

const TABS: { status?: ProductStatus; label: string }[] = [
  { label: "All" },
  { status: "active", label: "On sale" },
  { status: "draft", label: "Drafts" },
  { status: "inactive", label: "Inactive" },
];

export function VendorProductsPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") as ProductStatus | null) ?? undefined;
  const q = params.get("q") ?? undefined;
  const page = Number(params.get("page") ?? 1) || 1;
  const [search, setSearch] = useState(q ?? "");
  const [error, setError] = useState<string>();
  const queryClient = useQueryClient();
  const list = useMyProducts({ status, q, page });

  const remove = async (p: VendorProduct) => {
    if (!window.confirm(`Delete "${p.title}"? This can't be undone.`)) return;
    setError(undefined);
    try {
      await deleteProduct(p.id);
      await queryClient.invalidateQueries({ queryKey: ["vendor", "products"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't delete the product. Try again.");
    }
  };

  const go = (changes: Record<string, string | undefined>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in changes)) next.delete("page");
    setParams(next);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link to="/vendor" className="text-sm text-brand-700 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Your products</h1>
        </div>
        <Link to="/vendor/products/new" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">
          Add a product
        </Link>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-2">
          {TABS.map((t) => (
            <button
              key={t.label}
              role="tab"
              type="button"
              aria-selected={status === t.status}
              onClick={() => go({ status: t.status })}
              className={`rounded-full border px-3 py-1 text-sm ${status === t.status ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white hover:border-brand-600"}`}
            >
              {t.label}
              {list.data && <span className="ml-1 opacity-75">{t.status ? list.data.counts[t.status] : Object.values(list.data.counts).reduce((a, b) => a + b, 0)}</span>}
            </button>
          ))}
        </div>
        <form
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            go({ q: search.trim() || undefined });
          }}
        >
          <input
            type="search"
            aria-label="Search your products"
            placeholder="Search by title"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          />
        </form>
      </div>

      <FormError message={error} />

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <LoadError error={list.error} />
      ) : list.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          {q || status ? "No products match." : "You haven't added any products yet."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase text-slate-500">
                <tr>
                  <th className="px-4 py-3">Product</th>
                  <th className="px-4 py-3">Price</th>
                  <th className="px-4 py-3">Stock</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {list.data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-slate-100">
                          {p.images[0] && <img src={p.images[0].url} alt="" className="h-full w-full object-contain" />}
                        </div>
                        <div className="min-w-0">
                          <p className="line-clamp-1 font-medium">{p.title}</p>
                          {p.sku && <p className="text-xs text-slate-500">SKU {p.sku}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">{formatINR(p.price)}</td>
                    <td className={`px-4 py-3 ${p.stock === 0 ? "font-medium text-red-700" : ""}`}>{p.stock}</td>
                    <td className="px-4 py-3">
                      <StatusBadge status={p.status} label={p.status === "active" ? "On sale" : p.status} />
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <Link to={`/vendor/products/${p.id}`} className="text-brand-700 hover:underline">
                        Edit
                      </Link>
                      <button type="button" onClick={() => remove(p)} className="ml-4 text-red-700 hover:underline">
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={list.data} onPage={(n) => go({ page: String(n) })} />
        </>
      )}
    </div>
  );
}
