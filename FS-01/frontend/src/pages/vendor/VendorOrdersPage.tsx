import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { ApiError } from "../../api/client";
import { advancePart, PART_STATUS_LABEL, PAYOUT_TEXT, useVendorOrders, type VendorPart, type VendorPartStatus } from "../../api/orders";
import { LoadError, Loading, Pagination, StatusBadge } from "../../components/Catalog";
import { Field, FormError } from "../../components/Field";
import { OrderTimeline } from "../../components/OrderTimeline";
import { formatINR } from "../../lib/money";
import { orderDate } from "../OrdersPage";

const TABS: (VendorPartStatus | undefined)[] = [undefined, "placed", "packed", "shipped", "delivered", "cancelled"];

const ACTION: Record<"packed" | "shipped" | "delivered", string> = {
  packed: "Mark as packed",
  shipped: "Mark as shipped",
  delivered: "Mark as delivered",
};

function NextStep({ part }: { part: VendorPart }) {
  const queryClient = useQueryClient();
  const [tracking, setTracking] = useState({ carrier: "", number: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const next = part.nextStatus;
  if (!next) return null;

  const submit = async () => {
    setBusy(true);
    setErrors({});
    setError(undefined);
    try {
      await advancePart(part.id, next, next === "shipped" ? tracking : undefined);
      await queryClient.invalidateQueries({ queryKey: ["vendor", "orders"] });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't update the order. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {next === "shipped" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Courier" placeholder="Delhivery, BlueDart…" value={tracking.carrier} onChange={(e) => setTracking({ ...tracking, carrier: e.target.value })} error={errors["tracking.carrier"]} />
          <Field label="Tracking number" value={tracking.number} onChange={(e) => setTracking({ ...tracking, number: e.target.value })} error={errors["tracking.number"]} />
        </div>
      )}
      <FormError message={error} />
      <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? "Saving…" : ACTION[next]}
      </button>
    </div>
  );
}

function PartCard({ part }: { part: VendorPart }) {
  return (
    <article className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-semibold">{part.orderNumber}</h2>
          <p className="text-sm text-slate-500">
            {part.placedAt && `Paid ${orderDate(part.placedAt)} · `}
            {part.customer.name}
          </p>
        </div>
        <StatusBadge status={part.status} label={PART_STATUS_LABEL[part.status]} />
      </div>
      <OrderTimeline status={part.status} timeline={part.timeline} />
      <ul className="divide-y divide-slate-100 text-sm">
        {part.items.map((item) => (
          <li key={item.productId} className="flex justify-between gap-4 py-1.5">
            <span>
              {item.title} × {item.qty}
            </span>
            <span>{formatINR(item.lineTotal)}</span>
          </li>
        ))}
      </ul>
      <div className="grid gap-4 text-sm sm:grid-cols-2">
        {part.shippingAddress && (
          <div>
            <p className="font-medium">Ship to</p>
            <p className="text-slate-600">
              {part.shippingAddress.name}, {part.shippingAddress.line1}
              {part.shippingAddress.line2 && `, ${part.shippingAddress.line2}`}, {part.shippingAddress.city}, {part.shippingAddress.state} {part.shippingAddress.pincode}
              <br />
              Phone {part.shippingAddress.phone}
            </p>
          </div>
        )}
        <dl className="space-y-1">
          <div className="flex justify-between">
            <dt>Customer paid</dt>
            <dd>{formatINR(part.payable)}</dd>
          </div>
          <div className="flex justify-between text-slate-600">
            <dt>Platform commission</dt>
            <dd>− {formatINR(part.commission)}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-1 font-semibold">
            <dt>You receive</dt>
            <dd>{formatINR(part.vendorNet)}</dd>
          </div>
          {part.payout && (
            <div className="flex justify-between text-slate-600">
              <dt>Payout</dt>
              <dd>{PAYOUT_TEXT[part.payout.status]}</dd>
            </div>
          )}
        </dl>
      </div>
      {part.tracking && (
        <p className="text-sm text-slate-600">
          Tracking: {part.tracking.carrier} {part.tracking.number}
        </p>
      )}
      {part.cancelReason && <p className="text-sm text-slate-600">Cancelled: {part.cancelReason}</p>}
      <NextStep part={part} />
    </article>
  );
}

export function VendorOrdersPage() {
  const [status, setStatus] = useState<VendorPartStatus>();
  const [page, setPage] = useState(1);
  const { data, isPending, isError, error } = useVendorOrders({ status, page });

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;
  const total = Object.values(data.counts).reduce((a, b) => a + b, 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <Link to="/vendor" className="text-sm text-slate-500 hover:text-brand-700">
          ← Dashboard
        </Link>
      </div>
      <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-2">
        {TABS.map((tab) => (
          <button
            key={tab ?? "all"}
            type="button"
            role="tab"
            aria-selected={status === tab}
            onClick={() => {
              setStatus(tab);
              setPage(1);
            }}
            className={`rounded-full px-3 py-1 text-sm ${status === tab ? "bg-brand-600 text-white" : "border border-slate-300 bg-white hover:bg-slate-50"}`}
          >
            {tab ? PART_STATUS_LABEL[tab] : "All"} ({tab ? data.counts[tab] : total})
          </button>
        ))}
      </div>
      {data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">
          {total === 0 ? "No orders yet. Paid orders for your products appear here." : "No orders with this status."}
        </p>
      ) : (
        <div className="space-y-4">
          {data.items.map((part) => (
            <PartCard key={part.id} part={part} />
          ))}
        </div>
      )}
      <Pagination page={data} onPage={setPage} />
    </div>
  );
}
