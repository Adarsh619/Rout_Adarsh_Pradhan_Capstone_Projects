# 04 · Design decisions

[← System architecture](03-architecture.md) · [Index](README.md) · [Next: Data model →](05-data-model.md)

Each decision lists what was chosen, the alternatives, and why.

## 1. Razorpay Route for split payments (not Stripe Connect)

- **Chosen:** Razorpay Route in test mode. The customer pays the full amount once; each vendor has a **linked account**; after the payment, the platform creates one **transfer** per vendor for their share minus commission. The commission simply stays with the platform.
- **Alternative:** Stripe Connect. The brief allows either, but new Stripe Connect platforms in India are invite-only, and Stripe has no UPI.
- **Why:** INR and UPI out of the box, and Route has **on-hold transfers**, which gives us escrow for free (see 3).
- **Risk handled:** Route has to be enabled on the Razorpay account, and Razorpay has no official mock server. All payment code goes through a small `PaymentProvider` interface with two drivers, `razorpay` and `mock`. The mock signs its webhooks exactly like Razorpay, so the app, the tests and CI work without any account.

## 2. One order, one sub-order per vendor

- **Chosen:** checkout creates an `order` (what the customer paid) and one `subOrder` per vendor (what each vendor ships and is paid for).
- **Alternative:** one order with a status per line item.
- **Why:** each vendor packs and ships separately, so each needs its own status, tracking number, invoice, transfer and refund. A sub-order gives each vendor exactly the part they're allowed to see.

## 3. Pay vendors on delivery

- **Chosen:** each vendor's transfer is created **on hold** when the payment is captured, and released when that sub-order is delivered. Cancelling before shipping reverses the transfer and refunds that part.
- **Why:** protects customers (no money leaves for an order that never ships) and shows the order lifecycle driving the money, the core of a marketplace.

## 4. Money as integer paise, rates as basis points

- **Chosen:** ₹499.00 is stored as `49900`; 10% commission is `1000` bp; rounding happens once, in one place.
- **Why:** floating-point maths loses paise (`0.1 + 0.2 ≠ 0.3`), and across thousands of splits that would make the ledger stop balancing. Razorpay also expects paise.
- **Rule:** every paid order must satisfy `customer paid = Σ vendor transfers + platform share`; a test checks it for every coupon scenario.

## 5. MongoDB as a replica set, with transactions at checkout

- **Chosen:** a single-node replica set locally (Atlas is one already). Checkout creates the order and sub-orders and decrements stock in **one transaction**, with a conditional update `stock ≥ qty`.
- **Why:** two customers buying the last item at the same moment must not both succeed. Standalone MongoDB doesn't support multi-document transactions.

## 6. Elasticsearch fed by a background job

- **Chosen:** MongoDB is the source of truth. Every product, vendor or review change puts a `search-index` job on a queue; the worker re-reads the product and updates Elasticsearch. `npm run reindex` rebuilds the whole index.
- **Alternatives:** writing to Elasticsearch inside the request (slow, fails the request if search is down), or MongoDB Atlas Search (not the required stack).
- **Why:** requests stay fast, a search outage never blocks selling, and the index can always be rebuilt.

## 7. Files go straight between the browser and S3

- **Chosen:** the API hands out a **presigned PUT URL** limited to one key, content type and size (≤ 5 MB); the browser uploads directly. Invoices are private and downloaded through a link that expires in minutes.
- **Why:** the API never streams large files, and the bucket stays private.
- **Locally:** Adobe S3Mock (S3-compatible, in Docker). MinIO stopped publishing free Docker images in 2025, so it's no longer a simple choice. Code is identical for AWS; only the endpoint changes.

## 8. Redis for carts, sessions, cache and queues

- **Chosen:** one Redis for four jobs: carts (7-day TTL, guest carts too), refresh-token sessions (logout and token-reuse detection revoke them instantly), a short product cache, and BullMQ queues.
- **Why:** carts change constantly and don't need to be permanent; sessions must be revocable; and the brief asks for Redis cart and session caching.

## 9. JWT access token + rotating refresh cookie

- **Chosen:** 15-minute access token in memory; 7-day refresh token in an httpOnly, `SameSite` cookie, **rotated on every use**; reusing an old one kills the whole session.
- **Why:** a stolen access token expires quickly, JavaScript can't read the refresh token, and a stolen refresh token is detected the first time both copies are used.

## 10. Separate frontend and backend hosting, always on

- **Chosen:** frontend on Vercel; backend (API, worker, Redis, Elasticsearch) on its own Oracle Cloud Always Free ARM VM with Caddy for HTTPS; MongoDB Atlas; AWS S3.
- **Alternatives:** Render's free tier sleeps after 15 minutes (30–60 s first load), and hosted Elasticsearch trials expire after 14 days.
- **Why:** the brief asks for separate deployments, and reviewers may open the link at any time, weeks later. Render with a keep-alive ping is the fallback.

## 11. TypeScript and Zod on the backend

- **Chosen:** strict TypeScript; every request body, query and environment variable parsed with Zod.
- **Why:** order and payment code has many shapes (paise, statuses, ids); type errors there are expensive. Invalid input is rejected at the edge with a clear `validation_error`.
