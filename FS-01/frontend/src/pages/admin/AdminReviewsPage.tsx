import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { moderateReview, useAdminReviews } from "../../api/analytics";
import { LoadError, Loading, Pagination, StatusBadge } from "../../components/Catalog";

// Hiding a review takes it off the product page and out of the product's and store's ratings at once.
export function AdminReviewsPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"visible" | "hidden" | undefined>();
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string>();
  const list = useAdminReviews({ status, page });

  const toggle = async (id: string, next: "visible" | "hidden") => {
    setBusy(id);
    try {
      await moderateReview(id, next, next === "hidden" ? "Hidden by a moderator" : undefined);
      await queryClient.invalidateQueries({ queryKey: ["admin", "reviews"] });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-brand-700 hover:underline">
          ← Admin dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Reviews</h1>
      </div>
      <div role="tablist" aria-label="Filter reviews" className="flex gap-2">
        {([undefined, "visible", "hidden"] as const).map((s) => (
          <button
            key={s ?? "all"}
            type="button"
            role="tab"
            aria-selected={status === s}
            onClick={() => {
              setStatus(s);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-sm ${status === s ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white"}`}
          >
            {s === undefined ? "All" : s === "visible" ? "Visible" : "Hidden"}
          </button>
        ))}
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <LoadError error={list.error} />
      ) : list.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">No reviews here.</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
            {list.data.items.map((r) => (
              <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 p-4">
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <p>
                    <span className="text-amber-500" aria-label={`${r.rating} out of 5 stars`}>
                      {"★".repeat(r.rating)}
                    </span>{" "}
                    on{" "}
                    <Link to={`/products/${r.product.id}`} className="font-medium hover:text-brand-700">
                      {r.product.title}
                    </Link>
                    {r.status === "hidden" && (
                      <span className="ml-2">
                        <StatusBadge status="inactive" label="Hidden" />
                      </span>
                    )}
                  </p>
                  {r.title && <p className="font-medium">{r.title}</p>}
                  <p className="text-slate-700">{r.body}</p>
                  <p className="text-xs text-slate-500">
                    {r.authorName} · {new Date(r.createdAt).toLocaleDateString("en-IN")} · {r.verified ? "verified purchase" : "from the demo catalogue"}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={busy === r.id}
                  onClick={() => void toggle(r.id, r.status === "visible" ? "hidden" : "visible")}
                  className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60"
                >
                  {r.status === "visible" ? "Hide" : "Show"}
                  <span className="sr-only"> review by {r.authorName}</span>
                </button>
              </li>
            ))}
          </ul>
          <Pagination page={list.data} onPage={setPage} />
        </>
      )}
    </div>
  );
}
