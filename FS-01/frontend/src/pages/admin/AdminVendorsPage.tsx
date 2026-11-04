import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useAdminVendors, vendorAction, type AdminVendor, type VendorAction } from "../../api/admin";
import type { StoreStatus } from "../../api/catalog";
import { ApiError } from "../../api/client";
import { LoadError, Loading, Pagination, StatusBadge } from "../../components/Catalog";
import { FormError } from "../../components/Field";

const TABS: { status: StoreStatus; label: string }[] = [
  { status: "pending", label: "Waiting for review" },
  { status: "approved", label: "Approved" },
  { status: "suspended", label: "Suspended" },
  { status: "rejected", label: "Rejected" },
];

// What an admin can do from each status, matching the API's rules.
const ACTIONS: Record<StoreStatus, { action: VendorAction; label: string; needsReason: boolean; danger?: boolean }[]> = {
  pending: [
    { action: "approve", label: "Approve", needsReason: false },
    { action: "reject", label: "Reject", needsReason: true, danger: true },
  ],
  approved: [{ action: "suspend", label: "Suspend", needsReason: true, danger: true }],
  suspended: [{ action: "restore", label: "Restore", needsReason: false }],
  rejected: [],
};

function VendorRow({ vendor, onDone }: { vendor: AdminVendor; onDone: () => Promise<void> }) {
  const [asking, setAsking] = useState<VendorAction>();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const run = async (action: VendorAction, withReason?: string) => {
    setError(undefined);
    setBusy(true);
    try {
      await vendorAction(vendor.id, action, withReason);
      setAsking(undefined);
      setReason("");
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors.reason ?? err.message) : "Couldn't update the store. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-semibold">
            {vendor.storeName} <StatusBadge status={vendor.status} />
          </p>
          <p className="text-sm text-slate-600">
            {vendor.owner ? `${vendor.owner.name} · ${vendor.owner.email}` : "Owner account missing"} · {vendor.phone}
            {vendor.gstin && ` · GSTIN ${vendor.gstin}`}
          </p>
          {vendor.description && <p className="mt-1 max-w-2xl text-sm text-slate-700">{vendor.description}</p>}
          <p className="mt-1 text-xs text-slate-500">
            Applied {new Date(vendor.submittedAt).toLocaleDateString("en-IN")} · {vendor.productCount} products
            {vendor.status === "approved" && (
              <>
                {" · "}
                <Link to={`/stores/${vendor.slug}`} className="text-brand-700 hover:underline">
                  View store
                </Link>
              </>
            )}
          </p>
          {vendor.rejectionReason && <p className="mt-1 text-sm text-red-800">Reason given: {vendor.rejectionReason}</p>}
        </div>
        <div className="flex gap-2">
          {ACTIONS[vendor.status].map((a) => (
            <button
              key={a.action}
              type="button"
              disabled={busy}
              onClick={() => (a.needsReason ? setAsking(a.action) : void run(a.action))}
              className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-60 ${
                a.danger ? "border border-red-300 text-red-700 hover:bg-red-50" : "bg-brand-600 text-white hover:bg-brand-700"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      {asking && (
        <form
          className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(asking, reason);
          }}
        >
          <label className="block text-sm font-medium" htmlFor={`reason-${vendor.id}`}>
            Reason (the vendor will see this)
          </label>
          <textarea
            id={`reason-${vendor.id}`}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="block w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy} className="rounded-lg bg-red-700 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60">
              {asking === "reject" ? "Reject application" : "Suspend store"}
            </button>
            <button type="button" onClick={() => setAsking(undefined)} className="px-3 py-1.5 text-sm text-slate-600">
              Cancel
            </button>
          </div>
        </form>
      )}
      <FormError message={error} />
    </li>
  );
}

export function AdminVendorsPage() {
  const [params, setParams] = useSearchParams();
  const status = (params.get("status") as StoreStatus | null) ?? "pending";
  const page = Number(params.get("page") ?? 1) || 1;
  const queryClient = useQueryClient();
  const list = useAdminVendors({ status, page });

  return (
    <div className="space-y-6">
      <div>
        <Link to="/admin" className="text-sm text-brand-700 hover:underline">
          ← Admin dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Vendors</h1>
      </div>
      <div role="tablist" aria-label="Filter by status" className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.status}
            role="tab"
            type="button"
            aria-selected={status === t.status}
            onClick={() => setParams({ status: t.status })}
            className={`rounded-full border px-3 py-1 text-sm ${status === t.status ? "border-brand-600 bg-brand-600 text-white" : "border-slate-300 bg-white hover:border-brand-600"}`}
          >
            {t.label}
            {list.data && <span className="ml-1 opacity-75">{list.data.counts[t.status]}</span>}
          </button>
        ))}
      </div>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <LoadError error={list.error} />
      ) : list.data.items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500">Nothing here.</p>
      ) : (
        <>
          <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white shadow-sm">
            {list.data.items.map((v) => (
              <VendorRow key={v.id} vendor={v} onDone={() => queryClient.invalidateQueries({ queryKey: ["admin", "vendors"] })} />
            ))}
          </ul>
          <Pagination page={list.data} onPage={(n) => setParams({ status, page: String(n) })} />
        </>
      )}
    </div>
  );
}
