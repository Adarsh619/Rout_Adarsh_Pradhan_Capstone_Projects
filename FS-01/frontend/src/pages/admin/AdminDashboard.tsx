import { Link } from "react-router";
import { useAdminVendors } from "../../api/admin";
import { useAuth } from "../../auth/AuthContext";

function Card({ title, text, to, badge }: { title: string; text: string; to?: string; badge?: string }) {
  const body = (
    <>
      <h2 className="flex items-center justify-between font-semibold text-brand-700">
        {title}
        {badge && <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800">{badge}</span>}
      </h2>
      <p className="mt-2 text-sm text-slate-600">{text}</p>
    </>
  );
  const style = "block rounded-xl border border-slate-200 bg-white p-5 shadow-sm";
  return to ? (
    <Link to={to} className={`${style} hover:border-brand-600`}>
      {body}
    </Link>
  ) : (
    <article className={style}>{body}</article>
  );
}

export function AdminDashboard() {
  const { user } = useAuth();
  const vendors = useAdminVendors({ status: "pending" });
  const pending = vendors.data?.counts.pending ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">Signed in as {user?.name}.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card
          title="Vendors"
          to="/admin/vendors"
          text="Review store applications; approve, reject, suspend and restore stores."
          badge={pending ? `${pending} waiting` : undefined}
        />
        <Card title="Categories" to="/admin/categories" text="Departments and categories shoppers browse by." />
        <Card title="Coupons" to="/admin/coupons" text="Platform-wide discount codes, paid for by ShopSphere." />
        <Card title="Analytics" to="/admin/analytics" text="Sales, commission earned, daily sales, orders by status, top stores and products." />
        <Card title="Orders and refunds" to="/admin/orders" text="Find any order; cancel and refund a part; retry refunds that didn't go through." />
        <Card title="Reviews" to="/admin/reviews" text="Hide or show reviews; ratings follow at once." />
      </div>
      <Link to="/account" className="text-sm text-brand-700 underline">
        Account settings
      </Link>
    </div>
  );
}
