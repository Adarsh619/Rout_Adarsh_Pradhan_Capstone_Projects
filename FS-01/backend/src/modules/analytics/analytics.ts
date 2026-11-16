import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/db.js";
import type { LedgerType } from "../payments/ledger.model.js";
import { fillDays, TIME_ZONE, type DateRange } from "./date-range.js";

// Admin and vendor reports. Money comes from the append-only ledger (what actually moved) and the parts' payout
// status (where each share is now); counts come from orders. All amounts in paise. Sums are done by PostgreSQL.

// SUM() in raw SQL comes back as bigint; amounts here are far below 2^53, so plain numbers are safe.
const num = (v: bigint | number | null | undefined) => Number(v ?? 0);

// Sum of each ledger type over the matched entries; a type with no entries is 0.
async function ledgerTotals(where: Prisma.LedgerEntryWhereInput): Promise<(type: LedgerType) => number> {
  const rows = await prisma.ledgerEntry.groupBy({ by: ["type"], where, _sum: { amount: true } });
  const totals = new Map(rows.map((r) => [r.type, r._sum.amount ?? 0]));
  return (type) => totals.get(type) ?? 0;
}

// Where every share stands right now: held, waiting to be paid, paid, reversed.
async function escrow(where: Prisma.SubOrderWhereInput) {
  const rows = await prisma.subOrder.groupBy({
    by: ["payoutStatus"],
    where: { ...where, payoutStatus: { not: null } },
    _sum: { payoutAmount: true },
    _count: { _all: true },
  });
  const of = (s: string) => {
    const r = rows.find((x) => x.payoutStatus === s);
    return { amount: r?._sum.payoutAmount ?? 0, n: r?._count._all ?? 0 };
  };
  return {
    held: of("held").amount,
    released: of("released").amount + of("failed").amount,
    paid: of("paid").amount,
    reversed: of("reversed").amount,
    counts: { held: of("held").n, released: of("released").n + of("failed").n, paid: of("paid").n, reversed: of("reversed").n },
  };
}

export async function adminAnalytics(range: DateRange) {
  const inRange = { gte: range.start, lt: range.end };
  const t = await ledgerTotals({ createdAt: inRange });
  const commission = t("commission") - t("commission_reversal");
  const discounts = t("platform_discount") - t("platform_discount_reversal");

  // Paid parts in the range: what was sold, by whom, and which products.
  const sold = { placedAt: inRange };
  const kept = { ...sold, status: { not: "cancelled" as const } };
  const [gmv, cancelled, ordersByStatus, partsByStatus, daily, topVendors, topProducts, current, failingRefunds, owed] = await Promise.all([
    prisma.subOrder.aggregate({ where: sold, _sum: { itemsTotal: true } }),
    prisma.subOrder.aggregate({ where: { ...sold, status: "cancelled" }, _sum: { itemsTotal: true } }),
    prisma.order.groupBy({ by: ["status"], where: { createdAt: inRange }, _count: { _all: true } }),
    prisma.subOrder.groupBy({ by: ["status"], where: sold, _count: { _all: true } }),
    // Payments per Indian day.
    prisma.$queryRaw<{ _id: string; sales: bigint; orders: bigint }[]>`
      SELECT to_char("createdAt" AT TIME ZONE ${TIME_ZONE}, 'YYYY-MM-DD') AS "_id", SUM(amount) AS sales, COUNT(*) AS orders
      FROM ledger_entries
      WHERE type = 'payment' AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
      GROUP BY 1`,
    prisma.subOrder.groupBy({
      by: ["vendorId"],
      where: kept,
      _sum: { itemsTotal: true, commission: true },
      _count: { _all: true },
      orderBy: [{ _sum: { itemsTotal: "desc" } }, { vendorId: "asc" }],
      take: 5,
    }),
    prisma.$queryRaw<{ productId: string; title: string; storeName: string; units: bigint; sales: bigint }[]>`
      SELECT l."productId", MAX(l.title) AS title, MAX(s."vendorName") AS "storeName", SUM(l.qty) AS units, SUM(l.price * l.qty) AS sales
      FROM order_lines l JOIN sub_orders s ON s.id = l."subOrderId"
      WHERE s."placedAt" >= ${range.start} AND s."placedAt" < ${range.end} AND s.status <> 'cancelled'
      GROUP BY l."productId"
      ORDER BY sales DESC, l."productId"
      LIMIT 5`,
    escrow({}),
    prisma.subOrder.count({ where: { refundStatus: "failed" } }),
    // Refunds promised but not yet made by the payment provider: money still owed to customers. The ledger balances
    // once these go through (payment − refund includes them until then).
    prisma.subOrder.aggregate({ where: { refundAmount: { gt: 0 }, refundProviderRef: null }, _sum: { refundAmount: true } }),
  ]);
  const stores = await prisma.vendor.findMany({ where: { id: { in: topVendors.map((v) => v.vendorId) } }, select: { id: true, storeName: true, slug: true } });

  const dailyRows = daily.map((d) => ({ _id: d._id, sales: num(d.sales), orders: num(d.orders) }));
  const paidOrders = dailyRows.reduce((n, d) => n + d.orders, 0);
  return {
    range: { from: range.from, to: range.to },
    totals: {
      // Value of everything sold (paid parts, before discounts), and how much of that was later cancelled.
      gmv: gmv._sum.itemsTotal ?? 0,
      cancelledValue: cancelled._sum.itemsTotal ?? 0,
      // Money that actually came in, net of refunds.
      collected: t("payment") - t("refund"),
      refunds: t("refund"),
      paidOrders,
      averageOrderValue: paidOrders ? Math.round(t("payment") / paidOrders) : 0,
      commission,
      platformDiscounts: discounts,
      // What the platform keeps: commission minus the coupons it paid for.
      platformRevenue: commission - discounts,
      payoutsSent: t("payout"),
    },
    ordersByStatus: Object.fromEntries(ordersByStatus.map((r) => [r.status, r._count._all])),
    partsByStatus: Object.fromEntries(partsByStatus.map((r) => [r.status, r._count._all])),
    daily: fillDays(range.days, dailyRows, { sales: 0, orders: 0 }),
    topVendors: topVendors.map((v) => {
      const store = stores.find((s) => s.id === v.vendorId);
      return {
        vendorId: v.vendorId,
        storeName: store?.storeName ?? "",
        slug: store?.slug ?? "",
        sales: v._sum.itemsTotal ?? 0,
        orders: v._count._all,
        commission: v._sum.commission ?? 0,
      };
    }),
    topProducts: topProducts.map((p) => ({ productId: p.productId, title: p.title, storeName: p.storeName, units: num(p.units), sales: num(p.sales) })),
    // Right now, whatever the range: vendors' money still held, waiting to be paid, and paid.
    escrow: current,
    failingRefunds,
    refundsOwed: owed._sum.refundAmount ?? 0,
  };
}

export async function vendorEarnings(vendorId: string, range: DateRange, page: { page: number; limit: number }) {
  const sold = { vendorId, placedAt: { gte: range.start, lt: range.end } };
  const kept = { ...sold, status: { not: "cancelled" as const } };
  const [sums, ownCoupons, daily, current, parts, total] = await Promise.all([
    prisma.subOrder.aggregate({ where: kept, _sum: { itemsTotal: true, commission: true, vendorNet: true }, _count: { _all: true } }),
    // Only the store's own coupons cost it anything; platform coupons are paid by the platform.
    prisma.subOrder.aggregate({ where: { ...kept, discountBy: "vendor" }, _sum: { discountShare: true } }),
    prisma.$queryRaw<{ _id: string; net: bigint; orders: bigint }[]>`
      SELECT to_char("placedAt" AT TIME ZONE ${TIME_ZONE}, 'YYYY-MM-DD') AS "_id", SUM("vendorNet") AS net, COUNT(*) AS orders
      FROM sub_orders
      WHERE "vendorId" = ${vendorId}::uuid AND "placedAt" >= ${range.start} AND "placedAt" < ${range.end} AND status <> 'cancelled'
      GROUP BY 1`,
    escrow({ vendorId }),
    prisma.subOrder.findMany({
      where: sold,
      orderBy: [{ placedAt: "desc" }, { id: "desc" }],
      skip: (page.page - 1) * page.limit,
      take: page.limit,
    }),
    prisma.subOrder.count({ where: sold }),
  ]);
  return {
    range: { from: range.from, to: range.to },
    totals: {
      sales: sums._sum.itemsTotal ?? 0,
      couponDiscounts: ownCoupons._sum.discountShare ?? 0,
      commission: sums._sum.commission ?? 0,
      net: sums._sum.vendorNet ?? 0,
      orders: sums._count._all,
    },
    escrow: current,
    daily: fillDays(
      range.days,
      daily.map((d) => ({ _id: d._id, net: num(d.net), orders: num(d.orders) })),
      { net: 0, orders: 0 },
    ),
    items: parts.map((p) => ({
      id: p.id,
      orderNumber: p.orderNumber,
      placedAt: p.placedAt ? p.placedAt.toISOString() : null,
      status: p.status,
      itemsTotal: p.itemsTotal,
      discountShare: p.discountBy === "vendor" ? p.discountShare : 0,
      commission: p.commission,
      vendorNet: p.vendorNet,
      payout: { status: p.payoutStatus, paidAt: p.payoutPaidAt ? p.payoutPaidAt.toISOString() : null, reference: p.payoutProviderRef },
    })),
    page: page.page,
    limit: page.limit,
    total,
  };
}
