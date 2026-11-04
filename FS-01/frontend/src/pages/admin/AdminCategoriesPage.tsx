import { useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { createCategory, deleteCategory, updateCategory, useAdminCategories, type AdminCategory } from "../../api/admin";
import { ApiError } from "../../api/client";
import { LoadError, Loading, StatusBadge } from "../../components/Catalog";
import { FormError } from "../../components/Field";

export function AdminCategoriesPage() {
  const queryClient = useQueryClient();
  const list = useAdminCategories();
  const [name, setName] = useState("");
  const [parentId, setParentId] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["admin", "categories"] }),
      queryClient.invalidateQueries({ queryKey: ["categories"] }),
    ]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? (Object.values(err.fieldErrors)[0] ?? err.message) : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      await createCategory({ name, parentId: parentId || null });
      setName("");
    });
  };

  if (list.isPending) return <Loading />;
  if (list.isError) return <LoadError error={list.error} />;

  const departments = list.data.filter((c) => !c.parentId);
  const childrenOf = (id: string) => list.data.filter((c) => c.parentId === id);

  const row = (c: AdminCategory, child: boolean) => (
    <li key={c.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${child ? "pl-6" : ""}`}>
      <span className={child ? "" : "font-semibold"}>
        {c.name} <span className="text-xs font-normal text-slate-500">{c.productCount} products</span>
        {!c.isActive && (
          <span className="ml-2">
            <StatusBadge status="inactive" label="Hidden" />
          </span>
        )}
      </span>
      <span className="flex gap-3 text-sm">
        <button type="button" disabled={busy} onClick={() => void act(() => updateCategory(c.id, { isActive: !c.isActive }))} className="text-brand-700 hover:underline">
          {c.isActive ? "Hide" : "Show"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => window.confirm(`Delete "${c.name}"?`) && void act(() => deleteCategory(c.id))}
          className="text-red-700 hover:underline"
        >
          Delete
        </button>
      </span>
    </li>
  );

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-brand-700 hover:underline">
          ← Admin dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Categories</h1>
        <p className="mt-1 text-sm text-slate-600">Two levels: departments and their categories. A category with products can be hidden but not deleted.</p>
      </div>

      <form onSubmit={add} className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <label className="text-sm">
          <span className="block font-medium text-slate-700">New category</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 rounded-lg border border-slate-300 px-3 py-2" placeholder="e.g. Headphones" />
        </label>
        <label className="text-sm">
          <span className="block font-medium text-slate-700">Inside</span>
          <select value={parentId} onChange={(e) => setParentId(e.target.value)} className="mt-1 rounded-lg border border-slate-300 bg-white px-3 py-2">
            <option value="">— New department —</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || name.trim().length < 2} className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-60">
          Add
        </button>
      </form>

      <FormError message={error} />

      <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white px-5 shadow-sm">
        {departments.map((d) => (
          <li key={d.id} className="py-2">
            <ul className="divide-y divide-slate-50">
              {row(d, false)}
              {childrenOf(d.id).map((c) => row(c, true))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}
