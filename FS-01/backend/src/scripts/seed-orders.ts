import { loadEnv } from "../config/env.js";
import { createElasticsearch } from "../lib/elasticsearch.js";
import { logger } from "../lib/logger.js";
import { connectMongo, disconnectMongo } from "../lib/mongo.js";
import { createRedis } from "../lib/redis.js";
import { createS3, createStorage } from "../lib/s3.js";
import { hashPassword } from "../modules/auth/password.js";
import { CartStore, userCartKey } from "../modules/cart/cart-store.js";
import { Product } from "../modules/catalog/product.model.js";
import { couponKeyFor } from "../modules/coupons/coupon-service.js";
import { Invoice } from "../modules/invoices/invoice.model.js";
import { directInvoiceJobs } from "../modules/invoices/invoice-jobs.js";
import { Order, SubOrder } from "../modules/orders/order.model.js";
import { advancePart, cancelPart, markPaid, placeOrder, type OrderDeps } from "../modules/orders/order-service.js";
import { noReservations } from "../modules/orders/reservations.js";
import { LedgerEntry } from "../modules/payments/ledger.model.js";
import { directMoneyJobs } from "../modules/payments/money-jobs.js";
import { MockPaymentProvider, createPaymentProvider } from "../modules/payments/payment-provider.js";
import { MockPayoutProvider, type PayoutProvider } from "../modules/payments/payout-provider.js";
import { refreshRatings } from "../modules/reviews/ratings.js";
import { Review } from "../modules/reviews/review.model.js";
import { SearchIndexer } from "../modules/search/search-indexer.js";
import { noSearchSync } from "../modules/search/search-sync.js";
import { User } from "../modules/users/user.model.js";
import { Vendor } from "../modules/vendors/vendor.model.js";

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

// Moves everything about one order back by `delta` milliseconds, in the database directly so timestamps aren't reset.
async function backdate(orderId: unknown, delta: number) {
  const shift = (field: string) => ({ $cond: [{ $ifNull: [`$${field}`, false] }, { $add: [`$${field}`, delta] }, "$$REMOVE"] });
  await Order.collection.updateOne({ _id: orderId as never }, [
    { $set: { createdAt: shift("createdAt"), updatedAt: shift("updatedAt"), reservationExpiresAt: shift("reservationExpiresAt"), "payment.paidAt": shift("payment.paidAt"), completedAt: shift("completedAt"), cancelledAt: shift("cancelledAt") } },
  ]);
  await SubOrder.collection.updateMany({ orderId: orderId as never }, [
    {
      $set: {
        createdAt: shift("createdAt"),
        updatedAt: shift("updatedAt"),
        placedAt: shift("placedAt"),
        deliveredAt: shift("deliveredAt"),
        cancelledAt: shift("cancelledAt"),
        "payout.releasedAt": shift("payout.releasedAt"),
        "payout.paidAt": shift("payout.paidAt"),
        "refund.requestedAt": shift("refund.requestedAt"),
        "refund.processedAt": shift("refund.processedAt"),
        statusHistory: { $map: { input: "$statusHistory", as: "h", in: { $mergeObjects: ["$$h", { at: { $add: ["$$h.at", delta] } }] } } },
      },
    },
  ]);
  await LedgerEntry.collection.updateMany({ orderId: orderId as never }, [{ $set: { createdAt: { $add: ["$createdAt", delta] } } }]);
  await Invoice.collection.updateMany({ orderId: orderId as never }, [{ $set: { generatedAt: { $add: ["$generatedAt", delta] } } }]);
}

async function main() {
  const env = loadEnv();
  const password = process.env.DEMO_PASSWORD;
  if (!password || password.length < 10) throw new Error("Set DEMO_PASSWORD before seeding demo orders");

  await connectMongo(env.MONGO_URL);
  const redis = createRedis(env.REDIS_URL);
  const storage = createStorage(env, createS3(env));
  const es = createElasticsearch(env.ELASTICSEARCH_URL);

  // Buyers, each with a delivery address.
  const passwordHash = await hashPassword(password, env.BCRYPT_COST);
  const buyers = [];
  for (const b of BUYERS) {
    await User.updateOne({ email: b.email }, { $set: { role: "customer", status: "active", passwordHash }, $setOnInsert: { name: b.name, email: b.email } }, { upsert: true });
    const user = (await User.findOne({ email: b.email }))!;
    if (user.addresses.length === 0) {
      user.addresses.push({ name: b.name, phone: "9876543210", line1: "42 Demo Street", city: b.city, state: b.state, pincode: b.pincode, isDefault: true });
      await user.save();
    }
    buyers.push(user);
  }
  if (await Order.exists({ customerId: { $in: buyers.map((b) => b._id) } })) {
    logger.info("demo buyers already have orders; nothing to do");
    await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
    return;
  }

  // Every approved store gets a (simulated) payout account, so delivered shares are paid out.
  const payouts: PayoutProvider = new MockPayoutProvider();
  for (const v of await Vendor.find({ status: "approved", "payout.status": { $ne: "active" } })) {
    const { beneficiaryRef } = await payouts.registerBeneficiary({ vendorId: v.id as string, accountHolder: v.storeName, accountNumber: "000123456789", ifsc: "HDFC0001234" });
    v.set("payout", { accountHolder: v.storeName, bankLast4: "6789", ifsc: "HDFC0001234", provider: "mock", beneficiaryRef, status: "active", updatedAt: new Date() });
    await v.save();
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
  const products = await Product.find({ status: "active", stock: { $gte: 5 }, price: { $lte: 5_000_000 } }).select("_id vendorId");
  const vendors = new Map((await Vendor.find({ status: "approved" })).map((v) => [v.id as string, v]));
  const buyable = products.filter((p) => vendors.has(p.vendorId.toString()));
  if (buyable.length === 0) {
    // E.g. the catalogue was seeded with --no-images, so every product is still a draft.
    logger.warn("no products on sale; run seed-catalog (with photos) first");
    await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
    return;
  }
  const coupons = ["WELCOME10", "FLAT100", "VIKRAM5"];

  let placed = 0;
  let reviews = 0;
  const reviewed = new Set<string>();
  const ratingsToRefresh = new Map<string, string>();
  for (let i = 0; i < ORDERS; i++) {
    const buyer = pick(buyers);
    const key = userCartKey(buyer.id as string);
    await cart.clear(key);
    await redis.del(couponKeyFor(key));
    const lineCount = 1 + Math.floor(rand() * 3);
    for (let n = 0; n < lineCount; n++) await cart.setQty(key, pick(buyable).id as string, 1 + Math.floor(rand() * 2));
    if (i % 4 === 0) await redis.set(couponKeyFor(key), pick(coupons));

    let order;
    try {
      order = await placeOrder(deps, { userId: buyer.id as string, addressId: buyer.addresses[0]!._id.toString() });
    } catch {
      // The coupon didn't apply (minimum, store, already used): place the same cart without it.
      await redis.del(couponKeyFor(key));
      order = await placeOrder(deps, { userId: buyer.id as string, addressId: buyer.addresses[0]!._id.toString() });
    }
    const proof = payments.pay(order.payment!.providerOrderId!);
    await markPaid(deps, order.id as string, proof.providerPaymentId);

    // Older orders have travelled further: most of the last month's are delivered, this week's are on their way.
    const ageDays = Math.floor((i / ORDERS) * 30 + rand() * 1.5);
    const parts = await SubOrder.find({ orderId: order._id });
    for (const part of parts) {
      const vendorUser = vendors.get(part.vendorId.toString())!.userId.toString();
      const actor = { userId: vendorUser, role: "vendor" as const };
      const steps = ageDays >= 7 ? 3 : ageDays >= 3 ? 2 : ageDays >= 1 ? 1 : 0;
      if (ageDays >= 2 && rand() < 0.12) {
        await cancelPart(deps, { subOrderId: part.id as string, actor: { userId: buyer.id as string, role: "customer" }, reason: "Ordered by mistake" });
        continue;
      }
      if (steps >= 1) await advancePart(deps, { vendorId: part.vendorId.toString(), subOrderId: part.id as string, to: "packed", actor });
      if (steps >= 2) await advancePart(deps, { vendorId: part.vendorId.toString(), subOrderId: part.id as string, to: "shipped", tracking: { carrier: pick(["Delhivery", "BlueDart", "Ekart", "DTDC"]), number: `DL${100000 + i * 10}` }, actor });
      if (steps >= 3) {
        await advancePart(deps, { vendorId: part.vendorId.toString(), subOrderId: part.id as string, to: "delivered", actor });
        // About a third of delivered items get a verified review.
        const item = part.items[0]!;
        const reviewKey = `${buyer.id as string}:${item.productId.toString()}`;
        if (rand() < 0.35 && !reviewed.has(reviewKey)) {
          reviewed.add(reviewKey);
          const r = pick(REVIEWS);
          await Review.create({ productId: item.productId, vendorId: part.vendorId, userId: buyer._id, subOrderId: part._id, authorName: buyer.name, rating: r.rating, body: r.body });
          ratingsToRefresh.set(item.productId.toString(), part.vendorId.toString());
          reviews++;
        }
      }
    }

    // Spread over the last 30 days, at a daytime hour.
    const delta = -(ageDays * DAY_MS + Math.floor(rand() * 8) * 60 * 60 * 1000);
    await backdate(order._id, delta);
    await Review.collection.updateMany({ subOrderId: { $in: parts.map((p) => p._id) } }, [{ $set: { createdAt: { $add: ["$createdAt", delta] } } }]);
    placed++;
  }

  for (const [productId, vendorId] of ratingsToRefresh) await refreshRatings({ redis, searchSync: noSearchSync }, productId, vendorId);
  // Stock and ratings changed for many products: rebuild search in one go.
  const { indexed } = await new SearchIndexer(es, env.ES_INDEX).reindexAll();
  logger.info({ orders: placed, reviews, searchable: indexed }, "demo orders ready");
  await Promise.allSettled([disconnectMongo(), redis.quit(), es.close()]);
}

main().catch((err: unknown) => {
  logger.fatal({ err }, "seeding demo orders failed");
  process.exit(1);
});
