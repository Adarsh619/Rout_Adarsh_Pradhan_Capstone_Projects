import type { Types } from "mongoose";
import { Order, SubOrder } from "../orders/order.model.js";
import { LedgerEntry, type LedgerType } from "../payments/ledger.model.js";
import { fillDays, istDay, type DateRange } from "./date-range.js";

// Admin and vendor reports. Money comes from the append-only ledger (what actually moved) and the parts' payout
// status (where each share is now); counts come from orders. All amounts in paise.

// Sum of each ledger type over the matched entries; a type with no entries is 0.
async function ledgerTotals(match: Record<string, unknown>): Promise<(type: LedgerType) => number> {
  const rows = await LedgerEntry.aggregate<{ _id: LedgerType; total: number }>([{ $match: match }, { $group: { _id: "$type", total: { $sum: "$amount" } } }]);
  const totals = new Map(rows.map((r) => [r._id, r.total]));
  return (type) => totals.get(type) ?? 0;
}

// Where every share stands right now: held, waiting to be paid, paid, reversed.
async function escrow(match: Record<string, unknown>) {
  const rows = await SubOrder.aggregate<{ _id: string; amount: number; n: number }>([
    { $match: { ...match, "payout.status": { $exists: true } } },
    { $group: { _id: "$payout.status", amount: { $sum: "$payout.amount" }, n: { $sum: 1 } } },
  ]);
  const of = (s: string) => rows.find((r) => r._id === s) ?? { amount: 0, n: 0 };
  return {
    held: of("held").amount,
    released: of("released").amount + of("failed").amount,
    paid: of("paid").amount,
    reversed: of("reversed").amount,
    counts: { held: of("held").n, released: of("released").n + of("failed").n, paid: of("paid").n, reversed: of("reversed").n },
  };
}

export async function adminAnalytics(range: DateRange) {
  const inRange = { $gte: range.start, $lt: range.end };
  const t = await ledgerTotals({ createdAt: inRange });
  const commission = t("commission") - t("commission_reversal");
  const discounts = t("platform_discount") - t("platform_discount_reversal");

  // Paid parts in the range: what was sold, by whom, and which products.
  const soldMatch = { placedAt: inRange };
  const [gmv, ordersByStatus, partsByStatus, daily, topVendors, topProducts, current, failingRefunds] = await Promise.all([
    SubOrder.aggregate<{ items: number; cancelled: number; parts: number }>([
      { $match: soldMatch },
      {
        $group: {
          _id: null,
          items: { $sum: "$itemsTotal" },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, "$itemsTotal", 0] } },
          parts: { $sum: 1 },
        },
      },
    ]),
    Order.aggregate<{ _id: string; n: number }>([{ $match: { createdAt: inRange } }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    SubOrder.aggregate<{ _id: string; n: number }>([{ $match: soldMatch }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    LedgerEntry.aggregate<{ _id: string; sales: number; orders: number }>([
      { $match: { type: "payment", createdAt: inRange } },
      { $group: { _id: istDay("createdAt"), sales: { $sum: "$amount" }, orders: { $sum: 1 } } },
    ]),
    SubOrder.aggregate<{ _id: Types.ObjectId; storeName: string; slug: string; sales: number; orders: number; commission: number }>([
      { $match: { ...soldMatch, status: { $ne: "cancelled" } } },
      { $group: { _id: "$vendorId", storeName: { $last: "$vendorName" }, slug: { $last: "$vendorSlug" }, sales: { $sum: "$itemsTotal" }, orders: { $sum: 1 }, commission: { $sum: "$commission" } } },
      { $sort: { sales: -1, _id: 1 } },
      { $limit: 5 },
    ]),
    SubOrder.aggregate<{ _id: Types.ObjectId; title: string; storeName: string; units: number; sales: number }>([
      { $match: { ...soldMatch, status: { $ne: "cancelled" } } },
      { $unwind: "$items" },
      {
        $group: {
          _id: "$items.productId",
          title: { $last: "$items.title" },
          storeName: { $last: "$vendorName" },
          units: { $sum: "$items.qty" },
          sales: { $sum: { $multiply: ["$items.price", "$items.qty"] } },
        },
      },
      { $sort: { sales: -1, _id: 1 } },
      { $limit: 5 },
    ]),
    escrow({}),
    SubOrder.countDocuments({ "refund.status": "failed" }),
  ]);
  // Refunds promised but not yet made by the payment provider: money still owed to customers. The ledger balances
  // once these go through (payment − refund includes them until then).
  const [owed] = await SubOrder.aggregate<{ amount: number }>([
    { $match: { "refund.amount": { $gt: 0 }, "refund.providerRef": { $exists: false } } },
    { $group: { _id: null, amount: { $sum: "$refund.amount" } } },
  ]);

  const paidOrders = daily.reduce((n, d) => n + d.orders, 0);
  return {
    range: { from: range.from, to: range.to },
    totals: {
      // Value of everything sold (paid parts, before discounts), and how much of that was later cancelled.
      gmv: gmv[0]?.items ?? 0,
      cancelledValue: gmv[0]?.cancelled ?? 0,
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
    ordersByStatus: Object.fromEntries(ordersByStatus.map((r) => [r._id, r.n])),
    partsByStatus: Object.fromEntries(partsByStatus.map((r) => [r._id, r.n])),
    daily: fillDays(range.days, daily, { sales: 0, orders: 0 }),
    topVendors: topVendors.map((v) => ({ vendorId: v._id.toString(), storeName: v.storeName, slug: v.slug, sales: v.sales, orders: v.orders, commission: v.commission })),
    topProducts: topProducts.map((p) => ({ productId: p._id.toString(), title: p.title, storeName: p.storeName, units: p.units, sales: p.sales })),
    // Right now, whatever the range: vendors' money still held, waiting to be paid, and paid.
    escrow: current,
    failingRefunds,
    refundsOwed: owed?.amount ?? 0,
  };
}

export async function vendorEarnings(vendorId: Types.ObjectId, range: DateRange, page: { page: number; limit: number }) {
  const sold = { vendorId, placedAt: { $gte: range.start, $lt: range.end } };
  const [sums, daily, current, parts, total] = await Promise.all([
    SubOrder.aggregate<{ items: number; discounts: number; commission: number; net: number; orders: number }>([
      { $match: { ...sold, status: { $ne: "cancelled" } } },
      {
        $group: {
          _id: null,
          items: { $sum: "$itemsTotal" },
          // Only the store's own coupons cost it anything; platform coupons are paid by the platform.
          discounts: { $sum: { $cond: [{ $eq: ["$discountBy", "vendor"] }, "$discountShare", 0] } },
          commission: { $sum: "$commission" },
          net: { $sum: "$vendorNet" },
          orders: { $sum: 1 },
        },
      },
    ]),
    SubOrder.aggregate<{ _id: string; net: number; orders: number }>([
      { $match: { ...sold, status: { $ne: "cancelled" } } },
      { $group: { _id: istDay("placedAt"), net: { $sum: "$vendorNet" }, orders: { $sum: 1 } } },
    ]),
    escrow({ vendorId }),
    SubOrder.find(sold)
      .sort({ placedAt: -1, _id: -1 })
      .skip((page.page - 1) * page.limit)
      .limit(page.limit),
    SubOrder.countDocuments(sold),
  ]);
  const s = sums[0] ?? { items: 0, discounts: 0, commission: 0, net: 0, orders: 0 };
  return {
    range: { from: range.from, to: range.to },
    totals: { sales: s.items, couponDiscounts: s.discounts, commission: s.commission, net: s.net, orders: s.orders },
    escrow: current,
    daily: fillDays(range.days, daily, { net: 0, orders: 0 }),
    items: parts.map((p) => ({
      id: p.id as string,
      orderNumber: p.orderNumber,
      placedAt: p.placedAt ? p.placedAt.toISOString() : null,
      status: p.status,
      itemsTotal: p.itemsTotal,
      discountShare: p.discountBy === "vendor" ? (p.discountShare ?? 0) : 0,
      commission: p.commission,
      vendorNet: p.vendorNet,
      payout: { status: p.payout?.status ?? null, paidAt: p.payout?.paidAt ? p.payout.paidAt.toISOString() : null, reference: p.payout?.providerRef ?? null },
    })),
    page: page.page,
    limit: page.limit,
    total,
  };
}
