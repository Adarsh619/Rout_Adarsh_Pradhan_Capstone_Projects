import { SystemStatus } from "../components/SystemStatus";

const ROLES = [
  { title: "Customers", text: "Search every store at once, fill one cart from many sellers and pay once with UPI or card." },
  { title: "Vendors", text: "Open a store, list products with photos, ship orders and get paid when they are delivered." },
  { title: "Admins", text: "Approve sellers, set commission, run coupons and watch sales and earnings on one dashboard." },
];

export function HomePage() {
  return (
    <div className="space-y-10">
      <section className="rounded-2xl bg-brand-900 px-8 py-12 text-white">
        <p className="text-sm font-medium uppercase tracking-wide text-brand-100">Multi-vendor marketplace</p>
        <h1 className="mt-2 text-3xl font-bold sm:text-4xl">Many sellers. One cart. One checkout.</h1>
        <p className="mt-4 max-w-2xl text-brand-100">
          ShopSphere splits every payment between the vendors in your order and keeps a commission for the platform.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-3">
        {ROLES.map((r) => (
          <article key={r.title} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-semibold text-brand-700">{r.title}</h2>
            <p className="mt-2 text-sm text-slate-600">{r.text}</p>
          </article>
        ))}
      </section>

      <SystemStatus />
    </div>
  );
}
