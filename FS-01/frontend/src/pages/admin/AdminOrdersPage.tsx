import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { refundPart, retryRefund, useAdminOrders, type AdminOrder } from "../../api/analytics";
import { ApiError } from "../../api/client";
import { ORDER_STATUS_LABEL, PART_STATUS_LABEL, type OrderStatus, type PartStatus } from "../../api/orders";
import { LoadError, Loading, Pagination, StatusBadge } from "../../components/Catalog";
import { FormError } from "../../components/Field";
import { formatINR } from "../../lib/money";

const REFUND_TEXT: Record<string, string> = { pending: "Refund processing", processed: "Refunded", failed: "Refund not sent yet" };

function Part({ part, onDone }: { part: AdminOrder["parts"][number]; onDone: () => Promise<unknown> }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setAsking(false);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? (Object.values(err.fieldErrors)[0] ?? err.message) : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span>
          {part.storeName} · {formatINR(part.payable)} <StatusBadge status={part.status} label={PART_STATUS_LABEL[part.status as PartStatus]} />
          {part.refund && (
            <span className={`ml-2 ${part.refund.status === "failed" ? "text-amber-800" : "text-slate-600"}`}>
              {REFUND_TEXT[part.refund.status]} ({formatINR(part.refund.amount)})
            </span>
          )}
        </span>
        <span className="flex gap-3">
          {part.refund?.status === "failed" && (
            <button type="button" disabled={busy} onClick={() => void run(() => retryRefund(part.id))} className="text-brand-700 underline">
              Retry refund
            </button>
          )}
          {part.canRefund && !asking && (
            <button type="button" onClick={() => setAsking(true)} className="text-red-700 underline">
              Cancel and refund
            </button>
          )}
        </span>
      </div>
      {part.refund?.lastError && part.refund.status === "failed" && <p className="text-xs text-slate-500">Last answer from the payment provider: {part.refund.lastError}</p>}
      {asking && (
        <form
          className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(() => refundPart(part.id, reason));
          }}
        >
          <label className="block">
            Reason (the customer and the store see it)
            <input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5" placeholder="e.g. Parcel lost in transit" />
          </label>
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-red-700 px-3 py-1.5 font-medium text-white disabled:opacity-60">
              {busy ? "Refunding…" : `Cancel and refund ${formatINR(part.payable)}`}
            </button>
            <button type="button" onClick={() => setAsking(false)} className="px-3 py-1.5 text-slate-600">
              Keep it
            </button>
          </div>
        </form>
      )}
      <FormError message={error} />
    </li>
  );
}

// Find any order and, as support, cancel and refund a part (e.g. a parcel lost in transit) or retry a refund the
// payment provider refused.
export function AdminOrdersPage() {
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const refund = params.get("refund") ?? undefined;
  const page = Number(params.get("page") ?? 1) || 1;
  const [search, setSearch] = useState(q);
  const list = useAdminOrders({ q: q || undefined, refund, page });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["admin"] });

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-brand-700 hover:underline">
          ← Admin dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Orders and refunds</h1>
      </div>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(search.trim() ? { q: search.trim() } : {});
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <label htmlFor="order-search" className="sr-only">
          Order number or customer email
        </label>
        <input id="order-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Order number or customer email" className="w-72 max-w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm" />
        <button type="submit" className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-medium text-white">
          Search
        </button>
        <button
          type="button"
          aria-pressed={refund === "failed"}
          onClick={() => setParams(refund === "failed" ? {} : { refund: "failed" })}
          className={`rounded-full border px-3 py-1 text-sm ${refund === "failed" ? "border-amber-600 bg-amber-100 text-amber-900" : "border-slate-300 bg-white"}`}
        >
          Refunds not sent yet
        </button>
      </form>

      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <LoadError error={list.error} />
      ) : list.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">No orders found.</p>
      ) : (
        <>
          <ul className="space-y-3">
            {list.data.items.map((o) => (
              <li key={o.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold">
                    {o.orderNumber} <StatusBadge status={o.status} label={ORDER_STATUS_LABEL[o.status as OrderStatus]} />
                  </p>
                  <p className="text-sm text-slate-600">
                    {formatINR(o.grandTotal)}
                    {o.coupon && ` · ${o.coupon}`} · {new Date(o.createdAt).toLocaleDateString("en-IN")}
                  </p>
                </div>
                <p className="text-sm text-slate-500">
                  {o.customer.name} · {o.customer.email} · payment {o.payment.status}
                  {o.payment.refundedAmount > 0 && `, ${formatINR(o.payment.refundedAmount)} refunded`}
                </p>
                <ul className="mt-2 divide-y divide-slate-100">
                  {o.parts.map((p) => (
                    <Part key={p.id} part={p} onDone={refresh} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <Pagination page={list.data} onPage={(n) => setParams({ ...(q && { q }), ...(refund && { refund }), page: String(n) })} />
        </>
      )}
    </div>
  );
}
