# 04 · Design decisions

[← System architecture](03-architecture.md) · [Index](README.md) · [Next: Data model →](05-data-model.md)

Each decision lists what was chosen, the alternatives, and why.

## 1. Real Razorpay payments, our own split and escrow engine

- **Chosen:**
  - **Collecting money is real Razorpay (test mode):** a Razorpay order for the full amount, the Checkout popup (UPI, cards, netbanking), payment-signature checks, signed webhooks and partial refunds.
  - **Splitting it is our own code:** commission per sub-order, each vendor's share recorded in an append-only ledger, held until delivery (see 3).
  - **The final transfer to a vendor's bank** goes through a `PayoutProvider` interface. v1 ships one driver, `mock`, which behaves like a real payouts API (reference ids, signed `payout.processed` webhooks, occasional failures in tests) and is labelled **"simulated payout"** everywhere it shows.
- **What we tried first:**

  | Option | Result |
  |---|---|
  | **Razorpay Route** (linked accounts + on-hold transfers) | Since September 2025 it requires **₹40 lakh+ domestic turnover** (or ₹5 lakh+ export) proven with GST-3B returns, plus a payer-payee declaration ([Route FAQs](https://razorpay.com/docs/payments/route/faqs)). Not possible for a student project, even in test mode. |
  | **RazorpayX payouts** (Banking+) | "We only support registered businesses", test mode included. |
  | **Stripe Connect** | New Stripe accounts in India are invite-only; opening one as another country would mean misstating details. |
  | **Another gateway's split product** | Not in the required stack, and the same RBI rules apply in production. |

- **Why this design:** everything a customer touches is genuine Razorpay, and everything that makes a *marketplace* (commission, per-vendor shares, escrow, refunds, payouts, reconciliation) is built and tested in our code instead of hidden inside a gateway. A business that qualifies can add a `route` or `razorpayx` payout driver without touching orders, the ledger or the UI.
- **Offline and in CI:** Razorpay has no official mock server, so payment collection also has a `PaymentProvider` with `razorpay` and `mock` drivers. The mock signs webhooks exactly like Razorpay, so the app, the tests and CI run without any account; `PAYMENT_PROVIDER=razorpay` switches to real test mode.

## 2. One order, one sub-order per vendor

- **Chosen:** checkout creates an `order` (what the customer paid) and one `subOrder` per vendor (what each vendor ships and is paid for).
- **Alternative:** one order with a status per line item.
- **Why:** each vendor packs and ships separately, so each needs its own status, tracking number, invoice, payout and refund. A sub-order gives each vendor exactly the part they're allowed to see.

## 3. Pay vendors on delivery (escrow)

- **Chosen:** when the payment is captured, each vendor's share (minus commission) is **held** in the ledger. When that sub-order is delivered it is **released** and a `payout` job pays it out. Cancelling before shipping **reverses** the hold and refunds that part of the payment through Razorpay.
- **Why:** protects customers (no money goes to a vendor for an order that never ships) and shows the order lifecycle driving the money, the core of a marketplace.

## 4. Money as integer paise, rates as basis points

- **Chosen:** ₹499.00 is stored as `49900`; 10% commission is `1000` bp; rounding happens once, in one place.
- **Why:** floating-point maths loses paise (`0.1 + 0.2 ≠ 0.3`), and across thousands of splits that would make the ledger stop balancing. Razorpay also expects paise.
- **Rule:** every paid order must satisfy `customer paid = Σ vendor shares + platform share`; a test checks it for every coupon scenario.

## 5. MongoDB as a replica set, with transactions at checkout

- **Chosen:** a single-node replica set locally (Atlas is one already). Checkout creates the order and sub-orders and decrements stock in **one transaction**, with a conditional update `stock ≥ qty`.
- **Why:** two customers buying the last item at the same moment must not both succeed. Standalone MongoDB doesn't support multi-document transactions.
- **Version: MongoDB 7.0 in Docker and CI.** Every MongoDB 8.x release refuses to start on Linux kernels 6.19 and newer ([SERVER-121912](https://jira.mongodb.org/browse/SERVER-121912)), and GitHub's `ubuntu-latest` runners now run kernel 7.0, so the first CI runs failed. MongoDB's exemption for patched kernels misreads Ubuntu's version numbers ([SERVER-136848](https://jira.mongodb.org/browse/SERVER-136848), still open). 7.0 is a supported long-term release, has everything ShopSphere uses (transactions, aggregation), and the same code runs unchanged on MongoDB Atlas. Move back to 8.x once that fix ships.

## 6. Elasticsearch fed by a background job

- **Chosen:** MongoDB is the source of truth. Every product, vendor or review change puts a `search-index` job on a queue; the worker re-reads the product and updates Elasticsearch. `npm run reindex` rebuilds the whole index.
- **Alternatives:** writing to Elasticsearch inside the request (slow, fails the request if search is down), or MongoDB Atlas Search (not the required stack).
- **Why:** requests stay fast, a search outage never blocks selling, and the index can always be rebuilt.
- **Details that matter:** jobs carry only the product id and the worker re-reads MongoDB, so retries and out-of-order jobs are harmless. Searches go through an alias, so a rebuild fills a new index and switches over atomically with no downtime. Synonyms are applied at index time so typo tolerance still works at search time. See [Background jobs and search](08-background-jobs.md).

## 7. Files go straight between the browser and S3

- **Chosen:** the API hands out a **presigned PUT URL** limited to one key, content type and size (≤ 5 MB); the browser uploads directly. Invoices are private and downloaded through a link that expires in minutes.
- **Why:** the API never streams large files, and the bucket stays private.
- **Locally:** Adobe S3Mock (S3-compatible, in Docker). MinIO stopped publishing free Docker images in 2025, so it's no longer a simple choice. Code is identical for AWS; only the endpoint changes.
- **Two addresses for storage in Docker:** the API reaches S3Mock as `http://s3:9090`, but the browser can't resolve that name, so upload links are signed for `S3_PUBLIC_ENDPOINT` (`http://localhost:9090`). On AWS both are the same and the variable stays empty.
- **What the mock doesn't check:** S3Mock accepts any signature and ignores checksums, so a broken upload link would only fail on AWS. Two safeguards: the API re-checks every uploaded object (type, size, prefix) before using it, and a unit test asserts the link's signed headers and that it carries no precomputed checksum (the SDK's default would make AWS reject every browser upload).
- **Seed photos are copied into our bucket**, not hot-linked from DummyJSON's CDN, so the live demo doesn't depend on someone else's server.

## 8. Redis for carts, sessions, cache and queues

- **Chosen:** one Redis for four jobs: carts (7-day TTL, guest carts too), refresh-token sessions (logout and token-reuse detection revoke them instantly), a short product cache, and BullMQ queues.
- **Why:** carts change constantly and don't need to be permanent; sessions must be revocable; and the brief asks for Redis cart and session caching.

## 9. JWT access token + rotating refresh cookie

- **Chosen:** 15-minute access token in memory; 7-day refresh token in an httpOnly, `SameSite` cookie, **rotated on every use**; reusing an old one kills the whole session.
- **Why:** a stolen access token expires quickly, JavaScript can't read the refresh token, and a stolen refresh token is detected the first time both copies are used.
- **Details that matter in practice:** every request also checks the session still exists in Redis, so logout and password changes apply at once; two tabs refreshing together get a short grace period instead of being treated as theft; cookie endpoints require an `X-Requested-With` header against CSRF. See [Security](10-security.md).

## 10. Separate frontend and backend hosting, always on

- **Chosen:** frontend on Vercel; backend (API, worker, Redis, Elasticsearch) on its own Oracle Cloud Always Free ARM VM with Caddy for HTTPS; MongoDB Atlas; AWS S3.
- **Alternatives:** Render's free tier sleeps after 15 minutes (30–60 s first load), and hosted Elasticsearch trials expire after 14 days.
- **Why:** the brief asks for separate deployments, and reviewers may open the link at any time, weeks later.
- **Fallback:** Oracle's A1 capacity in Hyderabad was full every day of the first week. If no VM can be created by Day 8, the same Docker setup runs on an AWS EC2 t4g.small in Mumbai (2 vCPU, 2 GB plus swap, Elasticsearch heap 512 MB), paid from the AWS free-plan credits with a zero-spend budget alert. Render was dropped as the fallback because its free tier sleeps and can't run Elasticsearch.

## 11. TypeScript and Zod on the backend

- **Chosen:** strict TypeScript; every request body, query and environment variable parsed with Zod.
- **Why:** order and payment code has many shapes (paise, statuses, ids); type errors there are expensive. Invalid input is rejected at the edge with a clear `validation_error`.
