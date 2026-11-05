import { useState } from "react";
import { Link } from "react-router";
import { ORDER_STATUS_LABEL, PART_STATUS_LABEL, useMyOrders } from "../api/orders";
import { LoadError, Loading, Pagination, StatusBadge } from "../components/Catalog";
import { formatINR } from "../lib/money";

export const orderDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function OrdersPage() {
  const [page, setPage] = useState(1);
  const { data, isPending, isError, error } = useMyOrders(page);

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">My orders</h1>
      {data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          You haven't ordered anything yet.{" "}
          <Link to="/" className="text-brand-700 underline">
            Start shopping
          </Link>
        </p>
      ) : (
        <ul className="space-y-3">
          {data.items.map((o) => (
            <li key={o.id}>
              <Link to={`/orders/${o.id}`} className="flex gap-4 rounded-xl border border-slate-200 bg-white p-4 hover:shadow-md">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                  {o.image && <img src={o.image} alt="" className="h-full w-full object-contain p-1" />}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{o.title}</p>
                    <StatusBadge status={o.status} label={ORDER_STATUS_LABEL[o.status]} />
                  </div>
                  <p className="text-sm text-slate-500">
                    {o.orderNumber} · {orderDate(o.createdAt)} · {o.itemCount} {o.itemCount === 1 ? "item" : "items"} · {formatINR(o.grandTotal)}
                  </p>
                  {o.status !== "pending_payment" && o.status !== "expired" && (
                    <p className="text-xs text-slate-500">{o.parts.map((p) => `${p.storeName}: ${PART_STATUS_LABEL[p.status]}`).join(" · ")}</p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={data} onPage={setPage} />
    </div>
  );
}
