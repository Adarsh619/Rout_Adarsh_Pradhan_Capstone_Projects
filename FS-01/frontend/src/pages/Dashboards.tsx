import { Link } from "react-router";
import { useAuth } from "../auth/AuthContext";

function Card({ title, text }: { title: string; text: string }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold text-brand-700">{title}</h2>
      <p className="mt-2 text-sm text-slate-600">{text}</p>
    </article>
  );
}

export function VendorDashboard() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Seller dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">Welcome, {user?.name}.</p>
      </div>
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p className="font-medium">Next step: apply for your store</p>
        <p className="mt-1">
          Tell us about your store. Once an admin approves it you can list products and receive orders.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Products" text="List products with photos, prices and stock." />
        <Card title="Orders" text="Pack, ship and deliver your part of each order." />
        <Card title="Earnings" text="See what's held until delivery, released and paid out." />
      </div>
      <Link to="/account" className="text-sm text-brand-700 underline">
        Account settings
      </Link>
    </div>
  );
}

export function AdminDashboard() {
  const { user } = useAuth();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Admin dashboard</h1>
        <p className="mt-1 text-sm text-slate-600">Signed in as {user?.name}.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Card title="Vendors" text="Approve, reject and suspend stores; set commission." />
        <Card title="Catalogue" text="Categories, coupons and review moderation." />
        <Card title="Analytics" text="Sales, commission earned and orders by status." />
      </div>
      <Link to="/account" className="text-sm text-brand-700 underline">
        Account settings
      </Link>
    </div>
  );
}
