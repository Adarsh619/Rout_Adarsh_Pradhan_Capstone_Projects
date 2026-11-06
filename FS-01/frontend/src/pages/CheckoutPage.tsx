import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useCart, useCartKey } from "../api/cart";
import { ApiError } from "../api/client";
import { addAddress, addressesKey, orderKey, placeOrder, useAddresses, type Address, type AddressInput } from "../api/orders";
import { LoadError, Loading } from "../components/Catalog";
import { Field, FormError } from "../components/Field";
import { formatINR } from "../lib/money";

const EMPTY: AddressInput = { label: "", name: "", phone: "", line1: "", line2: "", city: "", state: "", pincode: "", isDefault: false };

export function AddressForm({ onSaved, onCancel }: { onSaved: (a: Address) => void; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof AddressInput) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError(undefined);
    setBusy(true);
    try {
      const res = await addAddress(form);
      queryClient.setQueryData(addressesKey, res.items);
      onSaved(res.address);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't save the address. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-3 rounded-xl border border-slate-200 bg-white p-5" aria-label="New address">
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Full name" autoComplete="name" value={form.name} onChange={set("name")} error={errors.name} />
        <Field label="Mobile number" autoComplete="tel" inputMode="tel" value={form.phone} onChange={set("phone")} error={errors.phone} />
      </div>
      <Field label="House number and street" autoComplete="address-line1" value={form.line1} onChange={set("line1")} error={errors.line1} />
      <Field label="Area or landmark (optional)" autoComplete="address-line2" value={form.line2} onChange={set("line2")} error={errors.line2} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="City" autoComplete="address-level2" value={form.city} onChange={set("city")} error={errors.city} />
        <Field label="State" autoComplete="address-level1" value={form.state} onChange={set("state")} error={errors.state} />
        <Field label="PIN code" autoComplete="postal-code" inputMode="numeric" value={form.pincode} onChange={set("pincode")} error={errors.pincode} />
      </div>
      <Field label="Label (optional)" placeholder="Home, Office…" value={form.label} onChange={set("label")} error={errors.label} />
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          {busy ? "Saving…" : "Save address"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50">
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export function AddressText({ a }: { a: Omit<Address, "id" | "isDefault" | "label"> }) {
  return (
    <span className="text-sm text-slate-600">
      {a.line1}
      {a.line2 && `, ${a.line2}`}, {a.city}, {a.state} {a.pincode} · {a.phone}
    </span>
  );
}

export function CheckoutPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const cartKey = useCartKey();
  const cart = useCart();
  const addresses = useAddresses();
  const [chosen, setChosen] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (cart.isPending || addresses.isPending) return <Loading />;
  if (cart.isError) return <LoadError error={cart.error} />;
  if (addresses.isError) return <LoadError error={addresses.error} />;

  if (!cart.data.canCheckout) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-semibold">{cart.data.groups.length ? "Your cart needs attention" : "Your cart is empty"}</h1>
        <Link to="/cart" className="mt-6 inline-block text-brand-700 underline">
          Back to your cart
        </Link>
      </div>
    );
  }

  const list = addresses.data;
  const addressId = chosen ?? list.find((a) => a.isDefault)?.id ?? list[0]?.id;
  const showForm = adding || list.length === 0;

  const submit = async () => {
    if (!addressId) return;
    setError(undefined);
    setBusy(true);
    try {
      const { order, payment } = await placeOrder({ addressId, expectedTotal: cart.data.grandTotal });
      queryClient.setQueryData(orderKey(order.id), { order, payment });
      await queryClient.invalidateQueries({ queryKey: cartKey });
      navigate(`/orders/${order.id}`);
    } catch (err) {
      // Prices or stock moved: refresh the cart so the summary shows the new numbers.
      if (err instanceof ApiError && ["price_changed", "cart_changed", "out_of_stock", "cart_empty", "coupon_invalid", "coupon_exhausted"].includes(err.code)) {
        await queryClient.invalidateQueries({ queryKey: cartKey });
      }
      setError(err instanceof ApiError ? err.message : "Couldn't place the order. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-3">
      <div className="space-y-8 lg:col-span-2">
        <h1 className="text-2xl font-semibold">Checkout</h1>

        <section aria-labelledby="deliver-to" className="space-y-3">
          <h2 id="deliver-to" className="text-lg font-semibold">
            1. Delivery address
          </h2>
          {list.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="sr-only">Choose a delivery address</legend>
              {list.map((a) => (
                <label key={a.id} className={`flex cursor-pointer gap-3 rounded-xl border bg-white p-4 ${a.id === addressId ? "border-brand-600 ring-1 ring-brand-600" : "border-slate-200"}`}>
                  <input type="radio" name="address" value={a.id} checked={a.id === addressId} onChange={() => setChosen(a.id)} className="mt-1" />
                  <span>
                    <span className="block font-medium">
                      {a.name}
                      {a.label && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs font-normal text-slate-600">{a.label}</span>}
                    </span>
                    <AddressText a={a} />
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {showForm ? (
            <AddressForm
              onSaved={(a) => {
                setChosen(a.id);
                setAdding(false);
              }}
              onCancel={list.length ? () => setAdding(false) : undefined}
            />
          ) : (
            list.length < 5 && (
              <button type="button" onClick={() => setAdding(true)} className="text-sm font-medium text-brand-700 underline">
                Add a new address
              </button>
            )
          )}
        </section>

        <section aria-labelledby="review" className="space-y-3">
          <h2 id="review" className="text-lg font-semibold">
            2. Review items
          </h2>
          {cart.data.groups.map((g, i) => (
            <div key={g.vendor.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="mb-2 text-sm text-slate-600">
                Part {i + 1} of {cart.data.groups.length} · sold and shipped by <span className="font-medium text-slate-900">{g.vendor.storeName}</span>
              </p>
              <ul className="space-y-1 text-sm">
                {g.items.map((item) => (
                  <li key={item.productId} className="flex justify-between gap-4">
                    <span>
                      {item.title} × {item.qty}
                    </span>
                    <span>{formatINR(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      </div>

      <aside className="h-fit space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:sticky lg:top-6">
        <h2 className="font-semibold">3. Pay</h2>
        <dl className="space-y-2 text-sm">
          <div className="flex justify-between">
            <dt>Items ({cart.data.itemCount})</dt>
            <dd>{formatINR(cart.data.itemsTotal)}</dd>
          </div>
          {cart.data.discount > 0 && (
            <div className="flex justify-between text-emerald-700">
              <dt>Coupon {cart.data.coupon?.code}</dt>
              <dd>− {formatINR(cart.data.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>Delivery</dt>
            <dd className="text-emerald-700">Free</dd>
          </div>
          <div className="flex justify-between border-t border-slate-100 pt-2 text-base font-semibold">
            <dt>Order total</dt>
            <dd>{formatINR(cart.data.grandTotal)}</dd>
          </div>
        </dl>
        <FormError message={error} />
        <button
          type="button"
          onClick={submit}
          disabled={busy || !addressId || showForm}
          className="w-full rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          {busy ? "Placing your order…" : "Place order and pay"}
        </button>
        <p className="text-xs text-slate-500">Your items are held for 15 minutes while you pay. Test mode: no real money is taken.</p>
      </aside>
    </div>
  );
}
