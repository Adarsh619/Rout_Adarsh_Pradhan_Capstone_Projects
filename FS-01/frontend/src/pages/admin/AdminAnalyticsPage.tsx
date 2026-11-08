import { useState } from "react";
import { Link } from "react-router";
import { useAdminAnalytics } from "../../api/analytics";
import { ORDER_STATUS_LABEL, PART_STATUS_LABEL, type OrderStatus, type PartStatus } from "../../api/orders";
import { LoadError, Loading } from "../../components/Catalog";
import { ColumnChart, RangePicker, StatTile, rangeFor } from "../../components/ColumnChart";
import { formatCompactINR, formatINR } from "../../lib/money";

function Counts<K extends string>({ title, counts, labels }: { title: string; counts: Record<string, number>; labels: Record<K, string> }) {
  const entries = (Object.keys(labels) as K[]).map((k) => [k, counts[k] ?? 0] as const).filter(([, n]) => n > 0);
  const total = entries.reduce((n, [, v]) => n + v, 0);
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="font-semibold">{title}</h2>
      {total === 0 ? (
        <p className="mt-2 text-sm text-slate-500">None in this period.</p>
      ) : (
        <dl className="mt-3 space-y-2 text-sm">
          {entries.map(([k, n]) => (
            <div key={k}>
              <div className="flex justify-between">
                <dt>{labels[k]}</dt>
                <dd className="tabular-nums">{n}</dd>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-slate-100">
                <div className="h-full rounded-full bg-slate-400" style={{ width: `${(n / total) * 100}%` }} />
              </div>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

export function AdminAnalyticsPage() {
  const [days, setDays] = useState(30);
  const { data, isPending, isError, error, isFetching } = useAdminAnalytics(rangeFor(days));

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;
  const t = data.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/admin" className="text-sm text-brand-700 hover:underline">
            ← Admin dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-sm text-slate-500">
            {new Date(data.range.from).toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – {new Date(data.range.to).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
            {isFetching && " · updating…"}
          </p>
        </div>
        <RangePicker days={days} onChange={setDays} />
      </div>

      {data.failingRefunds > 0 && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data.failingRefunds} {data.failingRefunds === 1 ? "refund hasn't" : "refunds haven't"} gone through yet ({formatINR(data.refundsOwed)} still owed to customers).{" "}
          <Link to="/admin/orders?refund=failed" className="font-medium underline">
            See them
          </Link>
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sales (GMV)" value={formatINR(t.gmv)} sub={t.cancelledValue ? `${formatINR(t.cancelledValue)} of it later cancelled` : "Value of everything sold"} />
        <StatTile label="Collected" value={formatINR(t.collected)} sub={t.refunds ? `after ${formatINR(t.refunds)} refunded` : "Payments received"} />
        <StatTile label="Commission earned" value={formatINR(t.commission)} sub={t.platformDiscounts ? `${formatINR(t.platformDiscounts)} spent on coupons` : undefined} />
        <StatTile label="Platform revenue" value={formatINR(t.platformRevenue)} sub="Commission minus platform coupons" />
        <StatTile label="Paid orders" value={String(t.paidOrders)} sub={t.paidOrders ? `${formatINR(t.averageOrderValue)} average` : undefined} />
        <StatTile label="Held for vendors" value={formatINR(data.escrow.held)} sub={`${data.escrow.counts.held} parts not yet delivered (now)`} />
        <StatTile label="Waiting to be paid out" value={formatINR(data.escrow.released)} sub="Delivered; payout pending (now)" />
        <StatTile label="Paid out to vendors" value={formatINR(t.payoutsSent)} sub="In this period (simulated payouts)" />
      </div>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <ColumnChart
          title="Daily sales (payments received)"
          data={data.daily.map((d) => ({ day: d.day, value: d.sales, note: `${d.orders} ${d.orders === 1 ? "order" : "orders"}` }))}
          format={formatCompactINR}
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Counts title="Orders by status" counts={data.ordersByStatus} labels={ORDER_STATUS_LABEL as Record<OrderStatus, string>} />
        <Counts
          title="Store parts by status"
          counts={data.partsByStatus}
          labels={Object.fromEntries(Object.entries(PART_STATUS_LABEL).filter(([k]) => k !== "awaiting_payment")) as Record<Exclude<PartStatus, "awaiting_payment">, string>}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Top stores</h2>
          {data.topVendors.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No sales in this period.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="pb-1 font-medium">Store</th>
                  <th className="pb-1 text-right font-medium">Orders</th>
                  <th className="pb-1 text-right font-medium">Sales</th>
                  <th className="pb-1 text-right font-medium">Commission</th>
                </tr>
              </thead>
              <tbody>
                {data.topVendors.map((v) => (
                  <tr key={v.vendorId} className="border-t border-slate-100">
                    <td className="py-1.5">
                      <Link to={`/stores/${v.slug}`} className="hover:text-brand-700">
                        {v.storeName}
                      </Link>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{v.orders}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatINR(v.sales)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatINR(v.commission)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="font-semibold">Top products</h2>
          {data.topProducts.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No sales in this period.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="pb-1 font-medium">Product</th>
                  <th className="pb-1 text-right font-medium">Units</th>
                  <th className="pb-1 text-right font-medium">Sales</th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.map((p) => (
                  <tr key={p.productId} className="border-t border-slate-100">
                    <td className="py-1.5">
                      <Link to={`/products/${p.productId}`} className="line-clamp-1 hover:text-brand-700">
                        {p.title}
                      </Link>
                      <span className="text-xs text-slate-500">{p.storeName}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{p.units}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatINR(p.sales)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
