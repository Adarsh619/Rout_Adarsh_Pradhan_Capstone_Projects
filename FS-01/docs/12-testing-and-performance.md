# 12 · Testing and performance

[← DevOps](11-devops.md) · [Index](README.md) · Next: Challenges and next steps (written on Day 10)

ShopSphere is tested at four levels, every one of them on every push and pull request (CI), and the live site was
load-tested. All numbers below are from **17 Nov 2026**, on the PostgreSQL + Prisma build.

| Level | Tool | What it proves | Count | Result |
|---|---|---|---|---|
| Backend unit | Vitest | Pure rules: money splits, coupons, commission, order states, search queries, tokens, config | 94 tests, 11 files | ✅ all pass |
| Backend integration | Vitest + Supertest against real PostgreSQL, Redis, Elasticsearch and S3Mock | Whole HTTP flows through the real app and databases | 102 tests, 9 files | ✅ all pass |
| Frontend components | Vitest + Testing Library (jsdom) | Pages and forms behave as a user sees them | 62 tests, 8 files | ✅ all pass |
| End to end | `scripts/smoke-test.sh` through Docker Compose + nginx | The built images, wired together, do a full sale | ~40 checks | ✅ passes |
| Load | k6 against the live site | Speed and errors with 50 shoppers browsing at once | 5,403 requests | ✅ 0 errors, p95 110 ms |

## Coverage

| | Lines | Branches | Functions | Command |
|---|---|---|---|---|
| **Backend, all tests (unit + integration)** | **93.5%** | 78.7% | 92.6% | `npm run test:coverage` (needs the Docker services) |
| Backend, unit tests only | 33.9% | 20.7% | 28.5% | `npx vitest run --coverage` (no services) |
| **Frontend** | **83.1%** | 67.8% | 73.2% | `npm run test:coverage` |

Unit tests alone cover a third of the backend on purpose: they target the pure `*-rules.ts` modules where the money
and state logic lives, while routes and services are exercised end to end by the integration tests. Entry points,
seed scripts and the generated Prisma client are left out of the count (the smoke test covers the entry points).

Backend coverage by area (all tests):

| Area | Lines | Branches | | Area | Lines | Branches |
|---|---|---|---|---|---|---|
| orders | 93.7% | 82.3% | | catalog | 97.0% | 78.1% |
| payments (ledger, refunds, payouts, webhooks) | 90.7% | 75.7% | | search | 87.1% | 76.6% |
| coupons | 98.9% | 80.2% | | vendors | 97.2% | 72.1% |
| analytics | 100% | 79.7% | | reviews | 90.0% | 61.1% |
| auth | 93.9% | 82.6% | | invoices | 91.8% | 81.8% |
| cart | 94.1% | 74.5% | | uploads | 96.3% | 91.7% |
| middleware | 98.7% | 91.8% | | account (addresses) | 79.6% | 47.8% |

The lowest branch numbers (addresses, reviews) are mostly optional-field handling (clearing a label, an optional
title) rather than untested flows.

## What the tests check

### The risky parts, tested against the real databases

| Risk | Test |
|---|---|
| Overselling the last unit | Six shoppers check out at once for three units: exactly three orders succeed, three get `409 out_of_stock`, stock ends at 0 |
| Paying twice / confirming twice | The same payment proof sent twice, and the same Razorpay webhook delivered twice: one confirmation, one ledger `payment` entry |
| Customer closes the tab after paying | A signed `payment.captured` webhook alone confirms the order |
| Payment after the order expired | Refunded in full, once, and recorded in the ledger |
| Forged webhooks | Unsigned or wrongly signed events get `400 invalid_signature` |
| Books not balancing | After payment, delivery, payout, cancellation and refund: `payment − refund + platform discount − its reversals = vendor shares + commission` |
| Vendor ships while the customer cancels | Conditional status updates: one wins, the other gets `409 invalid_transition` |
| Razorpay refusing refunds | The refund shows `failed`, and the hourly sweep sends it once refunds work again |
| Last use of a coupon | Two checkouts for a one-use coupon: one gets it; the use comes back if the order expires |
| Seeing other people's data | Vendors see only their own parts; customers only their own orders and invoices (404, not 403) |
| Sign-in abuse | 5 wrong passwords lock that email for 15 min; rate limits per IP; a reused refresh token signs the user out everywhere |
| Uploads | Only images under the uploader's own folder, checked in S3 (type, size) before they're saved |
| Search | Typos (`iphne`), synonyms, filters, facets, a suspended store's products disappearing, a rebuild with no downtime |

### Unit tests (no databases)

Money rules (commission per line, platform vs store coupons, splitting a discount across stores without losing a
paisa), coupon validity, order status rules, the search query builder, token signing, password rules, date ranges for
reports in Indian time, environment validation and the health report.

### Frontend

Sign-in and sign-up (including field errors and session expiry), browsing, search with filters, cart, checkout with an
address and the payment step, order pages and cancelling, vendor product forms, admin screens, the coupon field,
reviews and the system status badge. API calls are mocked with `mockApi` (`frontend/src/test/render.tsx`).

### End to end (smoke test)

`scripts/smoke-test.sh` drives the running stack through nginx with `curl`, like a browser would:
sign-up → refresh-cookie rotation → sign-out → admin approves a store → signed photo upload to storage → product
published → product page, store page, search (with a typo) and autocomplete → guest cart in two stores → cart kept on
sign-up → WELCOME10 coupon → checkout and stock reservation → signed test payment → vendor packs → share held →
payout details → delivery releases and pays the share → invoice PDF → review → cancelling the other store's part
refunds it → admin analytics and vendor earnings. CI runs it on the real Docker images after the other jobs pass.

## CI

`.github/workflows/fs01-ci.yml` on every push to `main` and every pull request touching `FS-01/`:

| Job | Runs | Typical time |
|---|---|---|
| Backend | lint, typecheck, unit tests with coverage, integration tests against PostgreSQL 17, Redis, Elasticsearch and S3Mock service containers, build | ~5 min |
| Frontend | lint, component tests, production build | ~1.5 min |
| Docker Compose smoke test | builds the images, starts the stack, seeds it, runs the smoke test | ~3 min |

Only commits whose CI passed are deployed: the server checks GitHub every 5 minutes and deploys the newest passing
commit on `main` ([DevOps](11-devops.md#continuous-deployment)). The move to PostgreSQL went through a pull request
whose CI passed before it was merged.

## Load test (live site)

[`perf/k6-browse.js`](../perf/k6-browse.js): virtual shoppers loop through categories → a search (sometimes sorted or
filtered) → autocomplete → a product page → its reviews → sometimes a store page, pausing 1–3 s between steps like a
person reading. Load: 20 shoppers for 1.5 min, then 50 for 1.5 min (~4 min in all). Read-only: it creates no data.
Run from a laptop in India against `https://shopsphere-adarsh.duckdns.org` (AWS Mumbai, t4g.small: 2 vCPU, 2 GB).

| | Result (PostgreSQL build, 17 Nov) | Target |
|---|---|---|
| Requests | 5,403 (26 per second), 1,018 shopper loops | |
| Errors | **0** (all 5,391 checks passed) | < 1% |
| All requests | median 43 ms · p95 **110 ms** · max 712 ms | p95 < 800 ms |
| Search | median 50 ms · p95 **122 ms** | p95 < 800 ms |
| Product page | median 40 ms · p95 **108 ms** | p95 < 500 ms |
| Product page from Redis cache | p95 101 ms | |
| Product page from PostgreSQL | p95 136 ms | |

The same test on the earlier MongoDB build (16 Nov) gave p95 104 ms overall and 115 ms for search, with 0 errors: the
database switch made no measurable difference, because search is served by Elasticsearch and product pages by the
Redis cache. Most of each request's time is the network round trip from the client to Mumbai; the server's own
processing is a few milliseconds. Results: [`perf/results-live.json`](../perf/results-live.json) (PostgreSQL),
[`perf/results-live-mongodb.json`](../perf/results-live-mongodb.json) (before).

**Not measured:** a 20,000-product catalogue and browser-level (Playwright) tests were planned but dropped for time;
the live catalogue has 214 products. Elasticsearch query times stay in the tens of milliseconds at that size
([Background jobs and search](08-background-jobs.md)).

## Running the tests

```bash
# from FS-01/: the services the integration tests need
docker compose up -d postgres redis elasticsearch s3

cd backend
npm test                    # unit tests (no services)
npm run test:integration    # integration tests (creates and migrates its own database, shopsphere_test)
npm run test:coverage       # both, with the coverage report in coverage-all/

cd ../frontend
npm test                    # component tests
npm run test:coverage       # with coverage

# whole stack, from FS-01/ (mock payments; DEMO_PASSWORD from .env)
DEMO_PASSWORD=... bash scripts/smoke-test.sh http://localhost:3001

# load test (read-only) against any running copy
docker run --rm -i -v "$PWD/perf:/perf" grafana/k6:0.57.0 run /perf/k6-browse.js
```
