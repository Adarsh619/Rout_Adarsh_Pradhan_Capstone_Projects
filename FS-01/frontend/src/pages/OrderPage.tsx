import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/client";
import {
  cancelPart,
  cancelUnpaidOrder,
  mockPay,
  ORDER_STATUS_LABEL,
  orderKey,
  PART_STATUS_LABEL,
  useOrder,
  verifyPayment,
  type Order,
  type PaymentStep,
} from "../api/orders";
import { LoadError, Loading, StatusBadge } from "../components/Catalog";
import { FormError } from "../components/Field";
import { OrderTimeline } from "../components/OrderTimeline";
import { formatINR } from "../lib/money";
import { AddressText } from "./CheckoutPage";
import { orderDate } from "./OrdersPage";

function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  if (!until) return undefined;
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  return { left, text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` };
}

// The test payment screen. With PAYMENT_PROVIDER=mock the server stands in for Razorpay: "Pay" makes it sign a payment,
// which is then verified exactly like a real one. Razorpay's own popup replaces this panel on Day 6.
function PaymentPanel({ order, payment }: { order: Order; payment: PaymentStep }) {
  const queryClient = useQueryClient();
  const countdown = useCountdown(payment.expiresAt);
  const [busy, setBusy] = useState<"pay" | "fail" | "cancel">();
  const [error, setError] = useState<string>();

  const run = async (kind: "pay" | "fail" | "cancel") => {
    setBusy(kind);
    setError(undefined);
    try {
      let updated: Order;
      if (kind === "cancel") updated = (await cancelUnpaidOrder(order.id)).order;
      else {
        const proof = await mockPay(payment.providerOrderId, kind === "pay" ? "success" : "failure");
        updated = (await verifyPayment({ orderId: order.id, ...proof })).order;
      }
      queryClient.setQueryData(orderKey(order.id), { order: updated, payment: null });
      await queryClient.invalidateQueries({ queryKey: ["orders", "list"] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
      if (err instanceof ApiError && err.code === "order_not_payable") await queryClient.invalidateQueries({ queryKey: orderKey(order.id) });
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <section aria-labelledby="pay-title" className="space-y-4 rounded-xl border-2 border-brand-600 bg-white p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="pay-title" className="text-lg font-semibold">
          Pay {formatINR(payment.amount)}
        </h2>
        {countdown && (
          <p className={`text-sm ${countdown.left < 120 ? "font-medium text-red-700" : "text-slate-600"}`}>
            {countdown.left > 0 ? `Items held for ${countdown.text}` : "Time's up: your items are being released"}
          </p>
        )}
      </div>
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Test payment screen. No real money moves. Choose what the payment does.
      </p>
      <FormError message={error} />
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => run("pay")}
          disabled={!!busy}
          className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60"
        >
          {busy === "pay" ? "Paying…" : `Pay ${formatINR(payment.amount)} (test)`}
        </button>
        <button type="button" onClick={() => run("fail")} disabled={!!busy} className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50 disabled:opacity-60">
          Simulate a failed payment
        </button>
        <button type="button" onClick={() => run("cancel")} disabled={!!busy} className="ml-auto text-sm text-slate-600 underline hover:text-red-700">
          Cancel this order
        </button>
      </div>
    </section>
  );
}

function CancelPart({ order, partId, storeName }: { order: Order; partId: string; storeName: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { order: updated } = await cancelPart(order.id, partId, reason.trim() || undefined);
      queryClient.setQueryData(orderKey(order.id), { order: updated, payment: null });
      await queryClient.invalidateQueries({ queryKey: ["orders", "list"] });
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't cancel. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-sm text-slate-600 underline hover:text-red-700">
        Cancel this part
      </button>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
      <p>
        Cancel the items from <strong>{storeName}</strong>? The rest of your order is not affected.
      </p>
      <label className="block">
        Reason (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-1.5" />
      </label>
      <FormError message={error} />
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={busy} className="rounded-lg bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800 disabled:opacity-60">
          {busy ? "Cancelling…" : "Yes, cancel"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="rounded-lg border border-slate-300 bg-white px-3 py-1.5">
          Keep it
        </button>
      </div>
    </div>
  );
}

export function OrderPage() {
  const { id = "" } = useParams();
  const { data, isPending, isError, error } = useOrder(id);
  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;
  const { order, payment } = data;
  const paid = order.payment.status === "paid";

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link to="/orders" className="text-sm text-slate-500 hover:text-brand-700">
        ← My orders
      </Link>
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">Order {order.orderNumber}</h1>
          <StatusBadge status={order.status} label={ORDER_STATUS_LABEL[order.status]} />
        </div>
        <p className="text-sm text-slate-500">
          Placed {orderDate(order.createdAt)} · {formatINR(order.grandTotal)}
          {paid && " · paid"}
        </p>
      </header>

      {order.status === "pending_payment" && payment && <PaymentPanel order={order} payment={payment} />}
      {order.status === "expired" && (
        <p role="status" className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          This order wasn't paid in time, so its items went back on sale. Nothing was charged.
        </p>
      )}
      {order.status === "confirmed" && paid && (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          Payment received. Each store packs and ships its part separately; follow them below.
        </p>
      )}

      {order.parts.map((part, i) => (
        <section key={part.id} aria-labelledby={`part-${part.id}`} className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`part-${part.id}`} className="font-semibold">
              Part {i + 1}: from{" "}
              <Link to={`/stores/${part.vendor.slug}`} className="hover:text-brand-700">
                {part.vendor.storeName}
              </Link>
            </h2>
            <StatusBadge status={part.status} label={PART_STATUS_LABEL[part.status]} />
          </div>
          <OrderTimeline status={part.status} timeline={part.timeline} />
          {part.tracking && (
            <p className="text-sm text-slate-600">
              Tracking: {part.tracking.carrier} {part.tracking.number}
            </p>
          )}
          <ul className="divide-y divide-slate-100 text-sm">
            {part.items.map((item) => (
              <li key={item.productId} className="flex items-center gap-3 py-2">
                <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-slate-100">{item.image && <img src={item.image} alt="" className="h-full w-full object-contain" />}</div>
                <Link to={`/products/${item.productId}`} className="flex-1 hover:text-brand-700">
                  {item.title} × {item.qty}
                </Link>
                <span>{formatINR(item.lineTotal)}</span>
              </li>
            ))}
          </ul>
          {part.canCancel && <CancelPart order={order} partId={part.id} storeName={part.vendor.storeName} />}
        </section>
      ))}

      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 sm:grid-cols-2">
        <div>
          <h2 className="mb-1 font-semibold">Delivering to</h2>
          <p className="text-sm font-medium">{order.shippingAddress.name}</p>
          <AddressText a={order.shippingAddress} />
        </div>
        <dl className="space-y-1 text-sm">
          <div className="flex justify-between">
            <dt>Items</dt>
            <dd>{formatINR(order.itemsTotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Delivery</dt>
            <dd>{order.shipping ? formatINR(order.shipping) : "Free"}</dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-1 font-semibold">
            <dt>Total</dt>
            <dd>{formatINR(order.grandTotal)}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
