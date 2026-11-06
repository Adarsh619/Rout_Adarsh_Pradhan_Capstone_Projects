import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import type { OwnStore } from "../../api/catalog";
import { ApiError } from "../../api/client";
import { myStoreKey, savePayoutDetails } from "../../api/vendor";
import { Field, FormError } from "../../components/Field";

// Where the store's earnings are paid. Payouts are simulated in this project (no bank is called), and only the
// last 4 digits of the account number are stored.
export function PayoutDetails({ store }: { store: OwnStore }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(!store.payout);
  const [form, setForm] = useState({ accountHolder: store.payout?.accountHolder ?? "", accountNumber: "", ifsc: store.payout?.ifsc ?? "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setError(undefined);
    try {
      const res = await savePayoutDetails(form);
      queryClient.setQueryData(myStoreKey, res.store);
      await queryClient.invalidateQueries({ queryKey: ["vendor", "orders"] });
      setNotice(res.payoutsStarted ? `Saved. ${res.payoutsStarted} waiting ${res.payoutsStarted === 1 ? "payout is" : "payouts are"} being sent now.` : "Saved.");
      setForm((f) => ({ ...f, accountNumber: "" }));
      setEditing(false);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="payout-title" className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 id="payout-title" className="font-semibold">
          Payout account
        </h2>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="text-sm text-brand-700 underline">
            Change
          </button>
        )}
      </div>
      <p className="text-sm text-slate-600">
        Your share of each order is held until it's delivered, then paid here. Payouts in this project are <strong>simulated</strong>: no bank is contacted.
      </p>
      {notice && (
        <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {notice}
        </p>
      )}
      {!editing && store.payout ? (
        <p className="text-sm">
          {store.payout.accountHolder} · account ending <strong>{store.payout.bankLast4}</strong> · {store.payout.ifsc}
        </p>
      ) : (
        <form onSubmit={submit} noValidate className="space-y-3" aria-label="Payout account">
          {!store.payout && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">Add an account so delivered orders can be paid out.</p>
          )}
          <FormError message={error} />
          <Field label="Account holder name" value={form.accountHolder} onChange={(e) => setForm({ ...form, accountHolder: e.target.value })} error={errors.accountHolder} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Account number"
              inputMode="numeric"
              autoComplete="off"
              value={form.accountNumber}
              onChange={(e) => setForm({ ...form, accountNumber: e.target.value })}
              error={errors.accountNumber}
              hint="Only the last 4 digits are kept."
            />
            <Field label="IFSC" value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value })} error={errors.ifsc} hint="11 characters, e.g. HDFC0001234" />
          </div>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
              {busy ? "Saving…" : "Save payout account"}
            </button>
            {store.payout && (
              <button type="button" onClick={() => setEditing(false)} className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50">
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </section>
  );
}
