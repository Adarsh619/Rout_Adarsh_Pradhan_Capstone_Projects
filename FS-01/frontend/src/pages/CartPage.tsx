import { Link } from "react-router";
import { MAX_LINE_QTY, PROBLEM_TEXT, useCart, useRemoveFromCart, useSetCartQty, type CartItem } from "../api/cart";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { LoadError, Loading } from "../components/Catalog";
import { FormError } from "../components/Field";
import { formatINR } from "../lib/money";

function Line({ item }: { item: CartItem }) {
  const setQty = useSetCartQty();
  const remove = useRemoveFromCart();
  const error = setQty.error ?? remove.error;
  const max = Math.max(1, Math.min(MAX_LINE_QTY, item.problem === "unavailable" ? 1 : Math.max(item.stock, item.qty)));

  return (
    <li className="flex gap-4 py-4">
      <Link to={`/products/${item.productId}`} className="h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-slate-200 bg-white">
        {item.image ? <img src={item.image.url} alt={item.image.alt} className="h-full w-full object-contain p-1" /> : null}
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Link to={`/products/${item.productId}`} className="line-clamp-2 font-medium hover:text-brand-700">
          {item.title}
        </Link>
        <p className="text-sm text-slate-600">{formatINR(item.price)} each</p>
        {item.problem && (
          <p className="text-sm font-medium text-red-700">
            {PROBLEM_TEXT[item.problem]}
            {item.problem === "not_enough_stock" && ` Only ${item.stock} left.`}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm">
          {item.problem !== "unavailable" && item.problem !== "out_of_stock" && (
            <label className="flex items-center gap-2">
              Qty
              <select
                value={item.qty}
                disabled={setQty.isPending}
                onChange={(e) => setQty.mutate({ productId: item.productId, qty: Number(e.target.value) })}
                className="rounded-lg border border-slate-300 bg-white px-2 py-1"
              >
                {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n} disabled={n > item.stock}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            onClick={() => remove.mutate(item.productId)}
            disabled={remove.isPending}
            className="text-slate-600 underline hover:text-red-700"
          >
            Remove<span className="sr-only"> {item.title}</span>
          </button>
        </div>
        {error && <p className="text-sm text-red-700">{error instanceof ApiError ? error.message : "Couldn't update your cart"}</p>}
      </div>
      <p className="shrink-0 font-semibold">{formatINR(item.lineTotal)}</p>
    </li>
  );
}

export function CartPage() {
  const { status, user } = useAuth();
  const { data: cart, isPending, isError, error } = useCart();

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;

  if (cart.groups.length === 0) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-semibold">Your cart is empty</h1>
        <p className="mt-2 text-slate-600">Find something you like and add it here.</p>
        <Link to="/" className="mt-6 inline-block rounded-lg bg-brand-600 px-4 py-2 text-white hover:bg-brand-700">
          Start shopping
        </Link>
      </div>
    );
  }

  const canBuy = status !== "signedIn" || user?.role === "customer";

  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <div className="space-y-6 lg:col-span-2">
        <h1 className="text-2xl font-semibold">Your cart</h1>
        {cart.groups.map((g) => (
          <section key={g.vendor.id} aria-labelledby={`store-${g.vendor.id}`} className="rounded-xl border border-slate-200 bg-white px-5">
            <h2 id={`store-${g.vendor.id}`} className="border-b border-slate-100 py-3 text-sm text-slate-600">
              Sold by{" "}
              <Link to={`/stores/${g.vendor.slug}`} className="font-medium text-slate-900 hover:text-brand-700">
                {g.vendor.storeName}
              </Link>
            </h2>
            <ul className="divide-y divide-slate-100">
              {g.items.map((item) => (
                <Line key={item.productId} item={item} />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <aside className="h-fit space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:sticky lg:top-6">
        <h2 className="font-semibold">Order summary</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt>Items ({cart.itemCount})</dt>
            <dd>{formatINR(cart.itemsTotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Delivery</dt>
            <dd className="text-emerald-700">Free</dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd>{formatINR(cart.itemsTotal)}</dd>
          </div>
        </dl>
        {cart.groups.length > 1 && (
          <p className="text-xs text-slate-500">
            {cart.groups.length} stores: you pay once, and each store ships its part separately.
          </p>
        )}
        <FormError message={cart.problems > 0 ? "Some items need attention before you can check out." : undefined} />
        {!canBuy ? (
          <p className="text-sm text-slate-600">Only customer accounts can buy. Sign in with a customer account to check out.</p>
        ) : cart.canCheckout ? (
          <Link
            to={status === "signedIn" ? "/checkout" : "/login?next=%2Fcheckout"}
            className="block rounded-lg bg-brand-600 px-4 py-2 text-center font-medium text-white hover:bg-brand-700"
          >
            {status === "signedIn" ? "Proceed to checkout" : "Sign in to check out"}
          </Link>
        ) : (
          <button type="button" disabled className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white opacity-50">
            Proceed to checkout
          </button>
        )}
      </aside>
    </div>
  );
}
