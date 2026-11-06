import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import type { OwnStore } from "../../api/catalog";
import { applyForStore, myStoreKey, updateStore, useMyProducts, useMyStore } from "../../api/vendor";
import { useAuth } from "../../auth/AuthContext";
import { LoadError, Loading, StatusBadge } from "../../components/Catalog";
import { PayoutDetails } from "./PayoutDetails";
import { StoreForm } from "./StoreForm";

function Banner({ tone, title, children }: { tone: "amber" | "red" | "emerald"; title: string; children?: React.ReactNode }) {
  const styles = {
    amber: "border-amber-200 bg-amber-50 text-amber-900",
    red: "border-red-200 bg-red-50 text-red-900",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-900",
  }[tone];
  return (
    <div role="status" className={`rounded-xl border p-5 text-sm ${styles}`}>
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1">{children}</div>}
    </div>
  );
}

function ApprovedStore({ store }: { store: OwnStore }) {
  const products = useMyProducts({});
  const counts = products.data?.counts;
  const stat = (label: string, value?: number) => (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value ?? "…"}</p>
    </div>
  );
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        {stat("Products on sale", counts?.active)}
        {stat("Drafts", counts?.draft)}
        {stat("Inactive", counts?.inactive)}
      </div>
      <div className="flex flex-wrap gap-3">
        <Link to="/vendor/products/new" className="rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700">
          Add a product
        </Link>
        <Link to="/vendor/products" className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium hover:bg-slate-50">
          Manage products
        </Link>
        <Link to="/vendor/orders" className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium hover:bg-slate-50">
          Orders to ship
        </Link>
        <Link to="/vendor/coupons" className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium hover:bg-slate-50">
          Coupons
        </Link>
        <Link to={`/stores/${store.slug}`} className="rounded-lg border border-slate-300 bg-white px-4 py-2 font-medium hover:bg-slate-50">
          View your store page
        </Link>
      </div>
    </div>
  );
}

export function VendorDashboard() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { data: store, isPending, isError, error } = useMyStore();
  const [editing, setEditing] = useState(false);

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;

  const saved = (s: OwnStore) => {
    queryClient.setQueryData(myStoreKey, s);
    setEditing(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{store ? store.storeName : "Seller dashboard"}</h1>
          <p className="mt-1 text-sm text-slate-600">Welcome, {user?.name}.</p>
        </div>
        {store && <StatusBadge status={store.status} label={store.status === "approved" ? "Open" : store.status} />}
      </div>

      {!store && (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <h2 className="font-semibold">Apply for your store</h2>
            <p className="mt-1 text-sm text-slate-600">An admin reviews every new store. Once approved you can list products and receive orders.</p>
          </div>
          <StoreForm defaultEmail={user?.email ?? ""} submitLabel="Submit application" onSubmit={async (input) => saved(await applyForStore(input))} />
        </section>
      )}

      {store?.status === "pending" && (
        <Banner tone="amber" title="Your application is waiting for approval">
          We received it on {new Date(store.submittedAt).toLocaleDateString("en-IN")}. You can still change it below.
        </Banner>
      )}
      {store?.status === "rejected" && (
        <Banner tone="red" title="Your application wasn't approved">
          <p>Reason: {store.rejectionReason}</p>
          <p className="mt-1">Update the details below and apply again.</p>
        </Banner>
      )}
      {store?.status === "suspended" && (
        <Banner tone="red" title="Your store is suspended">
          <p>Reason: {store.rejectionReason}</p>
          <p className="mt-1">Your products are hidden from customers until an admin restores the store.</p>
        </Banner>
      )}

      {store && (store.status === "pending" || store.status === "rejected") && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="mb-4 font-semibold">Store application</h2>
          <StoreForm
            store={store}
            defaultEmail={user?.email ?? ""}
            submitLabel={store.status === "rejected" ? "Apply again" : "Update application"}
            onSubmit={async (input) => saved(await applyForStore(input))}
          />
        </section>
      )}

      {store?.status === "approved" && (
        <>
          <ApprovedStore store={store} />
          <PayoutDetails store={store} />
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Store details</h2>
              {!editing && (
                <button type="button" onClick={() => setEditing(true)} className="text-sm text-brand-700 underline">
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <StoreForm store={store} defaultEmail={store.contactEmail} submitLabel="Save changes" onSubmit={async (input) => saved(await updateStore(input))} />
            ) : (
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-slate-500">About</dt>
                  <dd>{store.description || "—"}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Contact</dt>
                  <dd>
                    {store.contactEmail} · {store.phone}
                  </dd>
                </div>
                <div>
                  <dt className="text-slate-500">GSTIN</dt>
                  <dd>{store.gstin ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-slate-500">Store address</dt>
                  <dd>/stores/{store.slug}</dd>
                </div>
              </dl>
            )}
          </section>
        </>
      )}

      <Link to="/account" className="text-sm text-brand-700 underline">
        Account settings
      </Link>
    </div>
  );
}
