# 13 · Challenges and next steps

[← Testing and performance](12-testing-and-performance.md) · [Index](README.md) · Next: Setup (written on Day 10)

What was hard while building ShopSphere, how each problem was solved, what v1 deliberately leaves out, and what would
come next.

## Challenges and how they were solved

### 1. The brief changed the database three days before the deadline

**Problem.** On 17 Nov the brief's required tools changed to include **PostgreSQL and Prisma**. ShopSphere had been
built on MongoDB + Mongoose and was already live, with green CI.

**Solution.** Only the data layer moved; everything a reviewer sees stayed the same:

- A [written plan](specs/05-postgres-migration-plan.md) first: which embedded lists become tables (order lines,
  status history, product photos, addresses), which nested objects become prefixed columns, how each race is guarded.
- One Prisma schema (17 tables, enums, UUIDv7 ids, integer paise) and one migration; module by module, every query
  rewritten while routes, rules, the API's responses and the frontend stayed untouched.
- The existing tests were the safety net: the same 94 unit, 102 integration and 62 frontend tests and the end-to-end
  smoke test passed before and after, and the seeded ledger balanced to the paisa.
- Shipped through a pull request whose CI had to pass; the server deployed it by itself; the demo data was re-seeded.

**Lesson.** Keeping money and state rules in pure, database-free modules (`*-rules.ts`) and testing flows through the
HTTP API (not through the ORM) is what made a database swap a one-day job instead of a rewrite.

### 2. Two shoppers, one last unit

**Problem.** Without care, two checkouts can both read "1 in stock" and both succeed.

**Solution.** Stock is taken inside the checkout transaction with a conditional update
(`… SET stock = stock − qty WHERE stock >= qty`); the loser matches no row and its whole checkout rolls back. Every
later state change works the same way (`WHERE status = <the status it was read with>`). An integration test sends six
shoppers at three units at the same moment: exactly three succeed. See [Data model](05-data-model.md#races-and-transactions).

### 3. Splitting one payment between stores without Razorpay Route

**Problem.** The brief asks for split payments with commission. Razorpay Route (and RazorpayX payouts) aren't available
to an unregistered business, so Razorpay can't do the split itself.

**Solution.** Collect the full amount through real Razorpay test mode, then split it in ShopSphere's own
[append-only ledger](09-payments.md): commission per store's part, each vendor's share held until delivery, released,
then paid out through a `PayoutProvider` interface (a simulated driver in v1, labelled as such everywhere). A rule
checked by the tests: the books always balance.

### 4. The same payment reported twice, or not at all

**Problem.** A payment is reported by the checkout popup's callback *and* by Razorpay's webhook, in either order; a
customer may close the tab before the callback; a payment can arrive after the order expired.

**Solution.** Confirmation is a conditional update (only from `pending_payment`), webhook events are stored by their
id (a repeat is acknowledged and ignored), and a late payment is refunded in full exactly once. On the live site the
webhook confirmed the test order before the popup did, which is the case it exists for.

### 5. Razorpay's test account refuses refunds

**Problem.** Every refund (from the API *and* from Razorpay's own dashboard button) failed with "invalid request sent"
on the test account.

**Solution.** Treat it like an outage: the cancellation itself completes (stock back, share reversed, ledger balanced),
the refund shows "failed" to the customer and admin, and an hourly sweep retries until Razorpay accepts it. An
integration test covers exactly this. Also: UPI isn't offered on this test account, so test payments use Netbanking.

### 6. MongoDB 8 wouldn't start in CI

**Problem.** (Before the PostgreSQL move.) GitHub's runners moved to Linux kernel 7.0, and every MongoDB 8 release
refused to start on kernels 6.19 and newer.

**Solution.** Pinned MongoDB 7.0, a supported long-term release, after confirming it from the container's own logs.
The later move to PostgreSQL removed the issue entirely.

### 7. No free server with room for Elasticsearch

**Problem.** Elasticsearch needs a real machine that's always on. Oracle Cloud's free ARM servers in Hyderabad had no
capacity for a week; Render's free tier sleeps and can't run Elasticsearch; hosted Elasticsearch trials expire after
14 days.

**Solution.** The same Docker Compose setup on an AWS EC2 t4g.small in Mumbai (2 GB + swap, Elasticsearch heap capped
at 512 MB), paid from free-plan credits with a zero-spend budget alert. HTTPS from Caddy with a free DuckDNS name;
S3 access through the server's IAM role, so no AWS keys exist anywhere ([DevOps](11-devops.md)).

### 8. Signed out on every reload when the frontend moved to Vercel

**Problem.** The brief wants frontend and backend deployed separately. With the app on `vercel.app` calling the API on
another domain, the sign-in and cart cookies become third-party, which Safari and private windows block.

**Solution.** Vercel rewrites `/api/*` to the server, so the browser only ever talks to one origin. The API trusts
exactly two proxy hops (Vercel, then Caddy), so per-visitor rate limits still see the real address. Checked on the
live site through the request logs.

### 9. Smaller ones that cost time

| Problem | Fix |
|---|---|
| Presigned S3 uploads failed: the AWS SDK added a checksum the browser couldn't send | `requestChecksumCalculation: "WHEN_REQUIRED"` |
| S3Mock accepts any signature, so tests could pass with broken uploads | The API re-checks every upload in storage (type, size, owner's folder) before saving it |
| Recreating the API container made nginx answer 502 | nginx resolves the API's address on every request (`resolver 127.0.0.11` + a variable `proxy_pass`) |
| Zod 4's `.partial()` filled in defaults, so a PATCH changing one field reset others | `patchSchema()` |
| The nightly reset left tables created after the snapshot | Drop the whole schema first, then restore in one transaction |
| FS-01 and FS-04 on one PC wanted the same ports | FS-01 uses 3001 (web) and 5433 (Postgres); the projects share nothing |
| Prisma's migration engine couldn't be downloaded at runtime in the container | Install it at image build time (with OpenSSL), as root |

## Known limits of v1

| Area | Limit | Why |
|---|---|---|
| Payouts | Simulated (same interface a real payouts API would use) | Razorpay Route / RazorpayX need a registered business |
| Refunds | May show "failed" until Razorpay's test account accepts them; retried hourly | Test-account behaviour |
| Accounts | No email verification, password reset or two-factor sign-in | No email provider in scope |
| Shipping | Free (0) and tracking numbers typed by the vendor | No courier integration |
| Tax | GSTIN shown on invoices, but no GST calculation | Out of scope |
| Scale tested | 214 products, 50 concurrent shoppers | The 20,000-product and Playwright tests were dropped for time |
| Hosting | One server (no failover); a reset at 03:00 IST signs everyone out | Free-tier budget; shared demo accounts |
| Search | English synonyms only | Catalogue is English |

## Next steps

**For real customers**
1. Real vendor payouts through Razorpay Route (linked accounts) once the business is registered; the `PayoutProvider`
   interface already isolates it.
2. Email: verification, password reset, order and shipping notifications (a queue already exists for slow work).
3. GST on invoices, shipping charges by weight and pincode, a courier API for tracking.
4. Returns and partial refunds of single items (the ledger already supports per-part reversals).

**For scale and reliability**
5. Managed PostgreSQL with backups and a read replica; Redis and Elasticsearch on their own machines.
6. Load-test with a 20,000-product catalogue and checkout traffic (not just browsing); browser tests with Playwright.
7. Error tracking and metrics (Sentry, Prometheus/Grafana) beyond the uptime monitor and logs.

**For the product**
8. Vendor analytics over time (conversion, returns), wishlists, recommendations from what was bought together.
9. A mobile-first PWA and Hindi/regional-language search synonyms.
