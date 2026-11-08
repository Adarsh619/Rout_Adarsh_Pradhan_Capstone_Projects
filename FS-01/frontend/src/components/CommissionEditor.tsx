import { useState } from "react";
import { ApiError } from "../api/client";

const pct = (bp: number) => `${bp / 100}%`;

// Shows a commission rate and lets an admin change it, or go back to the inherited rate. Rates are basis points.
export function CommissionEditor({
  label,
  rateBp,
  inherited,
  onSave,
}: {
  label: string;
  rateBp: number | null;
  inherited: string;
  onSave: (rateBp: number | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(rateBp === null ? "" : String(rateBp / 100));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const save = async (next: number | null) => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(next);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? (Object.values(err.fieldErrors)[0] ?? err.message) : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <span className="text-xs text-slate-600">
        Commission {rateBp === null ? <>{inherited}</> : <strong>{pct(rateBp)}</strong>}{" "}
        <button type="button" onClick={() => setEditing(true)} className="text-brand-700 underline">
          Change<span className="sr-only"> commission for {label}</span>
        </button>
      </span>
    );
  }
  return (
    <form
      className="inline-flex flex-wrap items-center gap-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        const n = Number(value);
        if (value.trim() === "" || Number.isNaN(n) || n < 0 || n > 50) return setError("Enter 0 to 50");
        void save(Math.round(n * 100));
      }}
    >
      <label className="flex items-center gap-1">
        <span className="sr-only">Commission percent for {label}</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" className="w-16 rounded border border-slate-300 px-2 py-1" aria-invalid={error ? true : undefined} />%
      </label>
      <button type="submit" disabled={busy} className="rounded bg-brand-600 px-2 py-1 font-medium text-white disabled:opacity-60">
        Save
      </button>
      {rateBp !== null && (
        <button type="button" disabled={busy} onClick={() => void save(null)} className="text-slate-600 underline">
          Use {inherited.replace(/[()]/g, "")}
        </button>
      )}
      <button type="button" onClick={() => setEditing(false)} className="text-slate-500">
        Cancel
      </button>
      {error && (
        <span role="alert" className="text-red-700">
          {error}
        </span>
      )}
    </form>
  );
}
