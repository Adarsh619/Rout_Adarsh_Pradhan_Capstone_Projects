import { useState } from "react";
import { Link } from "react-router";
import { useVendorEarnings } from "../../api/analytics";
import { PART_STATUS_LABEL, PAYOUT_TEXT, type PartStatus, type PayoutStatus } from "../../api/orders";
import { LoadError, Loading, Pagination, StatusBadge } from "../../components/Catalog";
import { ColumnChart, RangePicker, StatTile, rangeFor } from "../../components/ColumnChart";
import { formatCompactINR, formatINR } from "../../lib/money";

export function VendorEarningsPage() {
  const [days, setDays] = useState(30);
  const [page, setPage] = useState(1);
  const { data, isPending, isError, error } = useVendorEarnings(rangeFor(days), page);

  if (isPending) return <Loading />;
  if (isError) return <LoadError error={error} />;
  const t = data.totals;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/vendor" className="text-sm text-brand-700 hover:underline">
            ← Dashboard
          </Link>
          <h1 className="text-2xl font-semibold">Earnings</h1>
          <p className="text-sm text-slate-500">Payouts in this project are simulated: no bank is contacted.</p>
        </div>
        <RangePicker
          days={days}
          onChange={(d) => {
            setDays(d);
            setPage(1);
          }}
        />
      </div>

      {!data.payoutAccount && data.escrow.released > 0 && (
        <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {formatINR(data.escrow.released)} is ready to be paid out, but your store has no payout account.{" "}
          <Link to="/vendor" className="font-medium underline">
            Add one on your dashboard
          </Link>
        </p>
      )}

      <section aria-label="Where your money is now" className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Held until delivery" value={formatINR(data.escrow.held)} sub={`${data.escrow.counts.held} paid orders on their way`} />
        <StatTile label="Released, being paid out" value={formatINR(data.escrow.released)} sub="Delivered" />
        <StatTile label="Paid out" value={formatINR(data.escrow.paid)} sub={`${data.escrow.counts.paid} orders, all time`} />
      </section>

      <section aria-label="This period" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Sales" value={formatINR(t.sales)} sub={`${t.orders} paid orders`} />
        <StatTile label="Your coupons" value={formatINR(t.couponDiscounts)} sub="Discounts your store paid for" />
        <StatTile label="Platform commission" value={formatINR(t.commission)} />
        <StatTile label="Your share" value={formatINR(t.net)} sub="Sales − your coupons − commission" />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <ColumnChart
          title="Your share by day (orders paid)"
          data={data.daily.map((d) => ({ day: d.day, value: d.net, note: `${d.orders} ${d.orders === 1 ? "order" : "orders"}` }))}
          format={formatCompactINR}
        />
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="font-semibold">Orders in this period</h2>
        {data.items.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No paid orders in this period.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="pb-1 font-medium">Order</th>
                  <th className="pb-1 font-medium">Status</th>
                  <th className="pb-1 text-right font-medium">Sales</th>
                  <th className="pb-1 text-right font-medium">Commission</th>
                  <th className="pb-1 text-right font-medium">Your share</th>
                  <th className="pb-1 font-medium">Payout</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((p) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="py-1.5">
                      {p.orderNumber}
                      <span className="block text-xs text-slate-500">{p.placedAt && new Date(p.placedAt).toLocaleDateString("en-IN")}</span>
                    </td>
                    <td className="py-1.5">
                      <StatusBadge status={p.status} label={PART_STATUS_LABEL[p.status as PartStatus]} />
                    </td>
                    <td className="py-1.5 text-right tabular-nums">
                      {formatINR(p.itemsTotal)}
                      {p.discountShare > 0 && <span className="block text-xs text-slate-500">− {formatINR(p.discountShare)} coupon</span>}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatINR(p.commission)}</td>
                    <td className="py-1.5 text-right font-medium tabular-nums">{p.status === "cancelled" ? "—" : formatINR(p.vendorNet)}</td>
                    <td className="py-1.5 text-slate-600">
                      {p.payout.status ? PAYOUT_TEXT[p.payout.status as PayoutStatus] : "—"}
                      {p.payout.reference && <span className="block font-mono text-xs text-slate-400">{p.payout.reference}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3">
          <Pagination page={data} onPage={setPage} />
        </div>
      </section>
    </div>
  );
}
