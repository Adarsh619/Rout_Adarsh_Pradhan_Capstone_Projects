import { Link } from "react-router";
import { SORT_LABELS, type Page, type ProductCard as Card, type Sort } from "../api/catalog";
import { formatINR } from "../lib/money";

export function Price({ price, mrp, discountPercent, large }: { price: number; mrp: number; discountPercent: number; large?: boolean }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-2">
      <span className={`font-semibold text-slate-900 ${large ? "text-3xl" : "text-lg"}`}>{formatINR(price)}</span>
      {discountPercent > 0 && (
        <>
          <span className="text-sm text-slate-500 line-through">
            <span className="sr-only">MRP </span>
            {formatINR(mrp)}
          </span>
          <span className="text-sm font-medium text-emerald-700">{discountPercent}% off</span>
        </>
      )}
    </p>
  );
}

export function Rating({ avg, count }: { avg: number; count: number }) {
  if (count === 0) return <span className="text-xs text-slate-500">No ratings yet</span>;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-slate-600">
      <span className="rounded bg-emerald-700 px-1.5 py-0.5 font-semibold text-white">
        {avg.toFixed(1)} <span aria-hidden="true">★</span>
      </span>
      <span>
        ({count.toLocaleString("en-IN")} {count === 1 ? "rating" : "ratings"})
      </span>
    </span>
  );
}

export function ProductCard({ product, showStore = true }: { product: Card; showStore?: boolean }) {
  return (
    <article className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:shadow-md">
      <Link to={`/products/${product.id}`} className="flex flex-1 flex-col">
        <div className="flex aspect-square items-center justify-center bg-slate-100">
          {product.image ? (
            <img src={product.image.url} alt={product.image.alt} loading="lazy" className="h-full w-full object-contain p-3" />
          ) : (
            <span className="text-sm text-slate-400">No photo</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-1 p-3">
          {product.brand && <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{product.brand}</p>}
          <h3 className="line-clamp-2 text-sm font-medium text-slate-900 group-hover:text-brand-700">{product.title}</h3>
          <Rating avg={product.ratingAvg} count={product.ratingCount} />
          <div className="mt-auto pt-1">
            <Price price={product.price} mrp={product.mrp} discountPercent={product.discountPercent} />
            {!product.inStock && <p className="text-xs font-medium text-red-700">Out of stock</p>}
          </div>
        </div>
      </Link>
      {showStore && (
        <Link to={`/stores/${product.vendor.slug}`} className="border-t border-slate-100 px-3 py-2 text-xs text-slate-500 hover:text-brand-700">
          Sold by {product.vendor.storeName}
        </Link>
      )}
    </article>
  );
}

export function ProductGrid({ page, showStore, emptyText }: { page: Page<Card>; showStore?: boolean; emptyText: string }) {
  if (page.items.length === 0) return <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">{emptyText}</p>;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {page.items.map((p) => (
        <ProductCard key={p.id} product={p} showStore={showStore} />
      ))}
    </div>
  );
}

export function Pagination({ page, onPage }: { page: Page<unknown>; onPage: (n: number) => void }) {
  const pages = Math.max(1, Math.ceil(page.total / page.limit));
  if (pages <= 1) return null;
  return (
    <nav aria-label="Pages" className="flex items-center justify-center gap-3 text-sm">
      <button
        type="button"
        disabled={page.page <= 1}
        onClick={() => onPage(page.page - 1)}
        className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-slate-600">
        Page {page.page} of {pages}
      </span>
      <button
        type="button"
        disabled={page.page >= pages}
        onClick={() => onPage(page.page + 1)}
        className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-40"
      >
        Next
      </button>
    </nav>
  );
}

export function SortSelect({ value, onChange }: { value: Sort; onChange: (s: Sort) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      Sort by
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Sort)}
        className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900"
      >
        {Object.entries(SORT_LABELS).map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

const BADGE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  approved: "bg-emerald-100 text-emerald-800",
  active: "bg-emerald-100 text-emerald-800",
  rejected: "bg-red-100 text-red-800",
  suspended: "bg-red-100 text-red-800",
  draft: "bg-slate-200 text-slate-700",
  inactive: "bg-slate-200 text-slate-700",
  pending_payment: "bg-amber-100 text-amber-800",
  awaiting_payment: "bg-amber-100 text-amber-800",
  confirmed: "bg-sky-100 text-sky-800",
  placed: "bg-sky-100 text-sky-800",
  packed: "bg-indigo-100 text-indigo-800",
  shipped: "bg-violet-100 text-violet-800",
  delivered: "bg-emerald-100 text-emerald-800",
  completed: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-slate-200 text-slate-700",
  expired: "bg-slate-200 text-slate-700",
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${label ? "" : "capitalize"} ${BADGE[status] ?? "bg-slate-100 text-slate-700"}`}>
      {label ?? status}
    </span>
  );
}

export function Loading({ text = "Loading…" }: { text?: string }) {
  return <p className="py-16 text-center text-slate-500">{text}</p>;
}

export function LoadError({ error }: { error: unknown }) {
  const notFound = (error as { status?: number })?.status === 404;
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">{notFound ? "Not found" : "Something went wrong"}</h1>
      <p className="mt-2 text-slate-600">
        {notFound ? "It may have been removed, or the link is wrong." : "Please check your connection and try again."}
      </p>
      <Link to="/" className="mt-4 inline-block text-brand-700 underline">
        Back to the shop
      </Link>
    </div>
  );
}
