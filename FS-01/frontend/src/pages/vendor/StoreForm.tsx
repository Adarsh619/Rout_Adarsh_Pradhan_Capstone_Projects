import { useState, type FormEvent } from "react";
import type { OwnStore } from "../../api/catalog";
import { ApiError } from "../../api/client";
import type { StoreInput } from "../../api/vendor";
import { Field, FormError, SubmitButton, TextArea } from "../../components/Field";

// The store application (and, once approved, the store settings). The API is the real check; this form just
// shows its per-field messages next to the inputs.
export function StoreForm({
  store,
  defaultEmail,
  submitLabel,
  onSubmit,
}: {
  store?: OwnStore | null;
  defaultEmail: string;
  submitLabel: string;
  onSubmit: (input: StoreInput) => Promise<unknown>;
}) {
  const [form, setForm] = useState<StoreInput>({
    storeName: store?.storeName ?? "",
    description: store?.description ?? "",
    contactEmail: store?.contactEmail ?? defaultEmail,
    phone: store?.phone ?? "",
    gstin: store?.gstin ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (field: keyof StoreInput) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [field]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError(undefined);
    setBusy(true);
    try {
      await onSubmit(form);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <FormError message={error} />
      <Field label="Store name" value={form.storeName} onChange={set("storeName")} error={errors.storeName} hint="Shown to customers and in your store's web address." />
      <TextArea label="About your store" rows={3} value={form.description} onChange={set("description")} error={errors.description} hint="What you sell and why customers should buy from you." />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Contact email" type="email" value={form.contactEmail} onChange={set("contactEmail")} error={errors.contactEmail} />
        <Field label="Mobile number" type="tel" inputMode="tel" value={form.phone} onChange={set("phone")} error={errors.phone} hint="10 digits, e.g. 98765 43210" />
      </div>
      <Field label="GSTIN (optional)" value={form.gstin} onChange={set("gstin")} error={errors.gstin} hint="Printed on your invoices if you have one." />
      <div className="max-w-56">
        <SubmitButton busy={busy}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
