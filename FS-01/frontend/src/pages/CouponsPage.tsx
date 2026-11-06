import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { ApiError } from "../api/client";
import { couponsKey, createCoupon, describeCoupon, updateCoupon, useCoupons, type CouponOwner } from "../api/coupons";
import { LoadError, Loading, Pagination, StatusBadge } from "../components/Catalog";
import { Field, FormError, Select } from "../components/Field";
import { formatINR, parseRupees } from "../lib/money";

const EMPTY = { code: "", type: "percent" as "percent" | "flat", amount: "", maxDiscount: "", minOrder: "", endsAt: "", usageLimit: "", perUserLimit: "1", description: "" };

function NewCoupon({ owner, onDone }: { owner: CouponOwner; onDone: () => void }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const local: Record<string, string> = {};
    // Percent coupons are typed as a percentage, flat ones in rupees; the API wants basis points and paise.
    const value = form.type === "percent" ? Math.round(Number(form.amount) * 100) : parseRupees(form.amount);
    if (!value || Number.isNaN(value)) local.value = form.type === "percent" ? "Enter a percentage, e.g. 10" : "Enter an amount in rupees";
    const maxDiscount = form.maxDiscount ? parseRupees(form.maxDiscount) : null;
    if (form.maxDiscount && !maxDiscount) local.maxDiscount = "Enter an amount in rupees";
    const minOrder = form.minOrder ? parseRupees(form.minOrder) : 0;
    if (minOrder === undefined) local.minOrder = "Enter an amount in rupees";
    if (Object.keys(local).length) return setErrors(local);

    setBusy(true);
    setErrors({});
    setError(undefined);
    try {
      await createCoupon(owner, {
        code: form.code,
        type: form.type,
        value: value!,
        maxDiscount: form.type === "percent" ? (maxDiscount ?? null) : null,
        minOrder: minOrder ?? 0,
        endsAt: form.endsAt ? new Date(`${form.endsAt}T23:59:59+05:30`).toISOString() : null,
        usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
        perUserLimit: Number(form.perUserLimit) || 1,
        description: form.description,
      });
      setForm(EMPTY);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't create the coupon. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate aria-label="New coupon" className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
      <h2 className="font-semibold">New coupon</h2>
      <FormError message={error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Code" value={form.code} onChange={set("code")} error={errors.code} hint="Letters and numbers, e.g. DIWALI10" />
        <Select label="Type" value={form.type} onChange={set("type")}>
          <option value="percent">Percentage off</option>
          <option value="flat">Fixed amount off</option>
        </Select>
        <Field label={form.type === "percent" ? "Percent off" : "Amount off (₹)"} inputMode="decimal" value={form.amount} onChange={set("amount")} error={errors.value} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {form.type === "percent" && <Field label="Maximum discount (₹, optional)" inputMode="decimal" value={form.maxDiscount} onChange={set("maxDiscount")} error={errors.maxDiscount} />}
        <Field label="Minimum order (₹, optional)" inputMode="decimal" value={form.minOrder} onChange={set("minOrder")} error={errors.minOrder} />
        <Field label="Last day (optional)" type="date" value={form.endsAt} onChange={set("endsAt")} error={errors.endsAt} />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Total uses (optional)" inputMode="numeric" value={form.usageLimit} onChange={set("usageLimit")} error={errors.usageLimit} />
        <Field label="Uses per customer" inputMode="numeric" value={form.perUserLimit} onChange={set("perUserLimit")} error={errors.perUserLimit} />
        <Field label="Description (optional)" value={form.description} onChange={set("description")} error={errors.description} />
      </div>
      <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
        {busy ? "Creating…" : "Create coupon"}
      </button>
    </form>
  );
}

// Admins manage platform coupons (paid for by ShopSphere); vendors manage their own store's (paid for by the store).
export function CouponsPage({ owner }: { owner: CouponOwner }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const { data, isPending, isError, error } = useCoupons(owner, page);
  const refresh = () => queryClient.invalidateQueries({ queryKey: couponsKey(owner) });

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{owner === "admin" ? "Platform coupons" : "Store coupons"}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {owner === "admin"
              ? "ShopSphere pays for these discounts; stores still receive their full share."
              : "Your store pays for these discounts: they only apply to your products, and commission is charged on what the customer paid."}
          </p>
        </div>
        <Link to={owner === "admin" ? "/admin" : "/vendor"} className="text-sm text-slate-500 hover:text-brand-700">
          ← Dashboard
        </Link>
      </div>
      <NewCoupon owner={owner} onDone={refresh} />
      {data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">No coupons yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {data.items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div>
                <p className="flex items-center gap-2 font-mono font-semibold">
                  {c.code}
                  <StatusBadge status={c.isActive ? "active" : "inactive"} label={c.isActive ? "Active" : "Off"} />
                </p>
                <p className="text-sm text-slate-600">{c.description || describeCoupon(c, formatINR)}</p>
                <p className="text-xs text-slate-500">
                  Used {c.usedCount}
                  {c.usageLimit ? ` of ${c.usageLimit}` : ""} times · {c.perUserLimit} per customer
                  {c.endsAt && ` · until ${new Date(c.endsAt).toLocaleDateString("en-IN")}`}
                </p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  await updateCoupon(owner, c.id, { isActive: !c.isActive });
                  await refresh();
                }}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
              >
                {c.isActive ? "Turn off" : "Turn on"}
                <span className="sr-only"> {c.code}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={data} onPage={setPage} />
    </div>
  );
}
