import { loadEnv } from "../config/env.js";
import { createElasticsearch } from "../lib/elasticsearch.js";
import { logger } from "../lib/logger.js";
import { connectDb, disconnectDb, prisma } from "../lib/db.js";
import { createRedis } from "../lib/redis.js";
import { createS3, createStorage } from "../lib/s3.js";
import { hashPassword } from "../modules/auth/password.js";
import { CartStore, userCartKey } from "../modules/cart/cart-store.js";
import { couponKeyFor } from "../modules/coupons/coupon-service.js";
import { directInvoiceJobs } from "../modules/invoices/invoice-jobs.js";
import { advancePart, cancelPart, markPaid, placeOrder, type OrderDeps } from "../modules/orders/order-service.js";
import { noReservations } from "../modules/orders/reservations.js";
import { directMoneyJobs } from "../modules/payments/money-jobs.js";
import { MockPaymentProvider, createPaymentProvider } from "../modules/payments/payment-provider.js";
import { MockPayoutProvider, type PayoutProvider } from "../modules/payments/payout-provider.js";
import { refreshRatings } from "../modules/reviews/ratings.js";
import { SearchIndexer } from "../modules/search/search-indexer.js";
import { noSearchSync } from "../modules/search/search-sync.js";

// Demo order history for the dashboards: a few dozen orders from five demo buyers over the last 30 days, going
// through the real checkout, payment (mock), delivery, payout and cancellation code, then moved back in time.
// The main demo customer (customer@shopsphere.test) is left without orders, to try things from a clean start.
// Runs once: if the demo buyers already have orders it stops (the nightly demo reset starts from an empty database).
//   npm run seed:orders            docker compose exec api node dist/scripts/seed-orders.js
// Needs the users and catalogue seeds first.

const ORDERS = 40;
const DAY_MS = 24 * 60 * 60 * 1000;

const BUYERS = [
  { name: "Ananya Rao", email: "ananya@shopsphere.test", city: "Bengaluru", state: "Karnataka", pincode: "560034" },
  { name: "Rahul Verma", email: "rahul@shopsphere.test", city: "Pune", state: "Maharashtra", pincode: "411001" },
  { name: "Fatima Khan", email: "fatima@shopsphere.test", city: "Hyderabad", state: "Telangana", pincode: "500081" },
  { name: "Karthik Iyer", email: "karthik@shopsphere.test", city: "Chennai", state: "Tamil Nadu", pincode: "600017" },
  { name: "Neha Gupta", email: "neha@shopsphere.test", city: "New Delhi", state: "Delhi", pincode: "110017" },
];

const REVIEWS = [
  { rating: 5, body: "Exactly as described and arrived well packed. Would buy again." },
  { rating: 4, body: "Good quality for the price. Delivery took a day longer than expected." },
  { rating: 5, body: "Very happy with this. The store kept me updated on shipping." },
  { rating: 3, body: "Does the job, but the finish could be better." },
];

// Same orders every run: a small seeded random generator.
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Moves everything about one order back by `delta` milliseconds, in SQL so @updatedAt doesn't reset the times.
// NULL + interval stays NULL, so times that were never set stay unset.
async function backdate(orderId: string, delta: number) {
  const shift = `${delta} milliseconds`;
  await prisma.$transaction([
    prisma.$executeRaw`UPDATE orders SET "createdAt" = "createdAt" + ${shift}::interval, "updatedAt" = "updatedAt" + ${shift}::interval,
      "reservationExpiresAt" = "reservationExpiresAt" + ${shift}::interval, "paidAt" = "paidAt" + ${shift}::interval,
      "completedAt" = "completedAt" + ${shift}::interval, "cancelledAt" = "cancelledAt" + ${shift}::interval
      WHERE id = ${orderId}::uuid`,
    prisma.$executeRaw`UPDATE sub_orders SET "createdAt" = "createdAt" + ${shift}::interval, "updatedAt" = "updatedAt" + ${shift}::interval,
      "placedAt" = "placedAt" + ${shift}::interval, "deliveredAt" = "deliveredAt" + ${shift}::interval, "cancelledAt" = "cancelledAt" + ${shift}::interval,
      "payoutReleasedAt" = "payoutReleasedAt" + ${shift}::interval, "payoutPaidAt" = "payoutPaidAt" + ${shift}::interval,
      "refundRequestedAt" = "refundRequestedAt" + ${shift}::interval, "refundProcessedAt" = "refundProcessedAt" + ${shift}::interval
      WHERE "orderId" = ${orderId}::uuid`,
    prisma.$executeRaw`UPDATE sub_order_events SET at = at + ${shift}::interval
      WHERE "subOrderId" IN (SELECT id FROM sub_orders WHERE "orderId" = ${orderId}::uuid)`,
    prisma.$executeRaw`UPDATE ledger_entries SET "createdAt" = "createdAt" + ${shift}::interval WHERE "orderId" = ${orderId}::uuid`,
    prisma.$executeRaw`UPDATE invoices SET "generatedAt" = "generatedAt" + ${shift}::interval WHERE "orderId" = ${orderId}::uuid`,
    prisma.$executeRaw`UPDATE reviews SET "createdAt" = "createdAt" + ${shift}::interval, "updatedAt" = "updatedAt" + ${shift}::interval
      WHERE "subOrderId" IN (SELECT id FROM sub_orders WHERE "orderId" = ${orderId}::uuid)`,
  ]);
}

async function main() {
  const env = loadEnv();
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) throw new Error("Set DEMO_PASSWORD before seeding demo orders");

  await connectDb(env.DATABASE_URL);
  const redis = createRedis(env.REDIS_URL);
  const storage = createStorage(env, createS3(env));
  const es = createElasticsearch(env.ELASTICSEARCH_URL);

  // Buyers, each with a delivery address.
  const passwordHash = await hashPassword(password, env.BCRYPT_COST);
  const buyers = [];
  for (const b of BUYERS) {
    const user = await prisma.user.upsert({
      where: { email: b.email },
      update: { role: "customer", status: "active", passwordHash },
      create: { name: b.name, email: b.email, role: "customer", passwordHash },
    });
    let address = await prisma.address.findFirst({ where: { userId: user.id }, orderBy: { id: "asc" } });
    address ??= await prisma.address.create({
      data: { userId: user.id, name: b.name, phone: "9876543210", line1: "42 Demo Street", city: b.city, state: b.state, pincode: b.pincode, isDefault: true },
    });
    buyers.push({ ...user, addressId: address.id });
  }
  if ((await prisma.order.count({ where: { customerId: { in: buyers.map((b) => b.id) } } })) > 0) {
    logger.info("demo buyers already have orders; nothing to do");
    await Promise.allSettled([disconnectDb(), redis.quit(), es.close()]);
    return;
  }

  // Every approved store gets a (simulated) payout account, so delivered shares are paid out.
  const payouts: PayoutProvider = new MockPayoutProvider();
  for (const v of await prisma.vendor.findMany({ where: { status: "approved", payoutStatus: { not: "active" } } })) {
    const { beneficiaryRef } = await payouts.registerBeneficiary({ vendorId: v.id, accountHolder: v.storeName, accountNumber: "000123456789", ifsc: "HDFC0001234" });
    await prisma.vendor.update({
      where: { id: v.id },
      data: {
        payoutAccountHolder: v.storeName,
        payoutBankLast4: "6789",
        payoutIfsc: "HDFC0001234",
        payoutProvider: "mock",
        payoutBeneficiaryRef: beneficiaryRef,
        payoutStatus: "active",
        payoutUpdatedAt: new Date(),
      },
    });
  }

  // Seeded orders always use the mock provider: never real payment calls, whatever PAYMENT_PROVIDER says.
  const payments = createPaymentProvider("mock", env.JWT_ACCESS_SECRET) as MockPaymentProvider;
  const deps: OrderDeps = {
    redis,
    searchSync: noSearchSync,
    payments,
    reservations: noReservations,
    reservationMinutes: 15,
    moneyJobs: directMoneyJobs({ payments, payouts }),
    invoiceJobs: directInvoiceJobs(storage),
  };
  const cart = new CartStore(redis);
  const rand = random(42);
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)]!;
  const buyable = await prisma.product.findMany({
    where: { status: "active", stock: { gte: 5 }, price: { lte: 5_000_000 }, vendor: { status: "approved" } },
    orderBy: { id: "asc" },
    select: { id: true, vendorId: true },
  });
  const vendors = new Map((await prisma.vendor.findMany({ where: { status: "approved" } })).map((v) => [v.id, v]));
  if (buyable.length === 0) {
    // E.g. the catalogue was seeded with --no-images, so every product is still a draft.
    logger.warn("no products on sale; run seed-catalog (with photos) first");
    await Promise.allSettled([disconnectDb(), redis.quit(), es.close()]);
    return;
  }
  const coupons = ["WELCOME10", "FLAT100", "VIKRAM5"];

  let placed = 0;
  let reviews = 0;
  const reviewed = new Set<string>();
  const ratingsToRefresh = new Map<string, string>();
  for (let i = 0; i < ORDERS; i++) {
    const buyer = pick(buyers);
    const key = userCartKey(buyer.id);
    await cart.clear(key);
    await redis.del(couponKeyFor(key));
    const lineCount = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < lineCount; n++) await cart.setQty(key, pick(buyable).id, 1 + Math.floor(rand() * 2));
    if (i % 4 === 0) await redis.set(couponKeyFor(key), pick(coupons));

    let order;
    try {
      order = await placeOrder(deps, { userId: buyer.id, addressId: buyer.addressId });
    } catch {
      // The coupon didn't apply (minimum, store, already used): place the same cart without it.
      await redis.del(couponKeyFor(key));
      order = await placeOrder(deps, { userId: buyer.id, addressId: buyer.addressId });
    }
    const proof = payments.pay(order.paymentProviderOrderId!);
    await markPaid(deps, order.id, proof.providerPaymentId);

    // Older orders have travelled further: most of the last month's are delivered, this week's are on their way.
    const ageDays = Math.floor((i / ORDERS) * 30 + rand() * 1.5);
    const parts = await prisma.subOrder.findMany({ where: { orderId: order.id }, orderBy: { id: "asc" }, include: { lines: { orderBy: { position: "asc" } } } });
    for (const part of parts) {
      const vendorUser = vendors.get(part.vendorId)!.userId;
      const actor = { userId: vendorUser, role: "vendor" as const };
      const steps = ageDays >= 7 ? 3 : ageDays >= 3 ? 2 : ageDays >= 1 ? 1 : 0;
      if (ageDays >= 2 && rand() < 0.12) {
        await cancelPart(deps, { subOrderId: part.id, actor: { userId: buyer.id, role: "customer" }, reason: "Ordered by mistake" });
        continue;
      }
      if (steps >= 1) await advancePart(deps, { vendorId: part.vendorId, subOrderId: part.id, to: "packed", actor });
      if (steps >= 2) await advancePart(deps, { vendorId: part.vendorId, subOrderId: part.id, to: "shipped", tracking: { carrier: pick(["Delhivery", "BlueDart", "Ekart", "DTDC"]), number: `DL${100000 + i * 10}` }, actor });
      if (steps >= 3) {
        await advancePart(deps, { vendorId: part.vendorId, subOrderId: part.id, to: "delivered", actor });
        // About a third of delivered items get a verified review.
        const item = part.lines[0]!;
        const reviewKey = `${buyer.id}:${item.productId}`;
        if (rand() < 0.35 && !reviewed.has(reviewKey)) {
          reviewed.add(reviewKey);
          const r = pick(REVIEWS);
          await prisma.review.create({
            data: { productId: item.productId, vendorId: part.vendorId, userId: buyer.id, subOrderId: part.id, authorName: buyer.name, rating: r.rating, body: r.body },
          });
          ratingsToRefresh.set(item.productId, part.vendorId);
          reviews++;
        }
      }
    }

    // Spread over the last 30 days, at a daytime hour.
    const delta = -(ageDays * DAY_MS + Math.floor(rand() * 8) * 60 * 60 * 1000);
    await backdate(order.id, delta);
    placed++;
  }

  for (const [productId, vendorId] of ratingsToRefresh) await refreshRatings({ redis, searchSync: noSearchSync }, productId, vendorId);
  // Stock and ratings changed for many products: rebuild search in one go.
  const { indexed } = await new SearchIndexer(es, env.ES_INDEX).reindexAll();
  logger.info({ orders: placed, reviews, searchable: indexed }, "demo orders ready");
  await Promise.allSettled([disconnectDb(), redis.quit(), es.close()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seeding demo orders failed");
  process.exit(1);
});
