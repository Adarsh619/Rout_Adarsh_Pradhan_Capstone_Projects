import { useState } from "react";
import { ApiError, api } from "../api/client";

// Fetches a 5-minute download link for a part's invoice and opens it. Links are made on demand, never stored,
// because invoice files are private.
export function InvoiceButton({ partId, invoiceNumber }: { partId: string; invoiceNumber: string | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const download = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await api<{ url: string }>(`/invoices/${partId}`);
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't get the invoice. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (!invoiceNumber) return <span className="text-sm text-slate-500">Invoice being prepared…</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" onClick={download} disabled={busy} className="text-sm font-medium text-brand-700 underline disabled:opacity-60">
        {busy ? "Preparing download…" : `Download invoice ${invoiceNumber}`}
      </button>
      {error && (
        <span role="alert" className="text-sm text-red-700">
          {error}
        </span>
      )}
    </span>
  );
}
