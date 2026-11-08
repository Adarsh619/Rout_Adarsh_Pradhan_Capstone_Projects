# FS-01 · ShopSphere: 10-Day Build Tracker

Tick a box (`[x]`) when an item is done. Each day ends with something that works, a commit (approved first), and the matching doc.
Started **Tue 3 Nov 2026**. Days 4 and 7 each finished a day early, so the remaining days were re-dated on 5 and 8 Nov. Final deadline: **20 Nov 2026**.

**Legend:** 🛠 build (Claude + you) · 👤 your own task (accounts, recording, writing) · ✅ end-of-day proof

---

## Day 1 · Tue 3 Nov · Plan & scaffold (brief step 1)
- [x] 🛠 Specs: PRD, app flow, roles, database schema, API list (`docs/specs/`)
- [x] 🛠 Architecture diagram (`docs/assets/architecture.png`)
- [x] 🛠 Scaffold `backend/` (Node 24, Express, TypeScript) and `frontend/` (React, Vite, Tailwind)
- [x] 🛠 `docker-compose.yml`: MongoDB (replica set), Redis, Elasticsearch, S3Mock, api, worker, web
- [x] 🛠 `.env.example`, `/health` endpoint, CI `.github/workflows/fs01-ci.yml` (lint + test)
- [x] 🛠 Docs 01–05 drafted (overview, features & roles, architecture, design decisions, data model)
- [x] 👤 Create Razorpay account (test mode). Route and RazorpayX checked: not available to unregistered businesses → own split engine + simulated payouts (design decision 1)
- [ ] 👤 Create FS-01's own Oracle A1 VM (2 OCPU / 12 GB, its own network), following [ORACLE_SERVER_SETUP.md](ORACLE_SERVER_SETUP.md). Retry daily if out of capacity
- [x] ✅ `docker compose up` → all services healthy, CI green

## Day 2 · Wed 4 Nov · Authentication & roles (brief step 2)
- [x] 🛠 Register, login, refresh, logout, me, change password
- [x] 🛠 bcrypt, short-lived access JWT, rotating refresh cookie stored in Redis
- [x] 🛠 `requireAuth` / `requireRole` middleware, login rate limit, Helmet, CORS
- [x] 🛠 React: login/register pages, role-based routes (customer, vendor, admin dashboards)
- [x] 🛠 Tests: auth flows, role checks, token rotation; doc 10 (security) started
- [ ] 👤 Oracle VM retry
- [x] ✅ All three roles sign in and land on their own dashboard

## Day 3 · Thu 5 Nov · Vendors, products, S3 images (brief step 3)
- [x] 🛠 Vendor application → admin approval / suspension
- [x] 🛠 Categories; product create / edit / delete (vendor owns only their products)
- [x] 🛠 Image upload straight from the browser to S3 (S3Mock locally), type and size limits
- [x] 🛠 Seed script: DummyJSON + Fake Store → 214 products, 5 vendors (+1 pending), 27 categories, photos copied to S3 (sample reviews kept for Day 7)
- [x] 🛠 Tests: ownership, validation, approval flow; doc 06 (API) started
- [ ] 👤 Oracle VM retry
- [x] ✅ A vendor adds a product with images and it shows on the store page

## Day 4 · Fri 6 Nov · Elasticsearch search (brief step 4)
- [x] 🛠 Index + mappings, background job keeps it in sync, `npm run reindex` (zero-downtime alias switch)
- [x] 🛠 Full-text search (typo-tolerant, title boosted, shop synonyms, falls back to most words)
- [x] 🛠 Filters: category, brand, price range, rating, vendor, in stock
- [x] 🛠 Sorting: relevance, price ↑↓, rating, newest; facet counts; autocomplete
- [x] 🛠 Search page with filters kept in the URL
- [x] 🛠 Tests for search; doc 08 (background jobs) started
- [ ] 👤 Oracle VM retry
- [x] ✅ Search "iphne" finds iPhones, filters show live counts

## Day 5 · Fri 6 Nov · Cart, checkout, order lifecycle (brief step 5)
- [x] 🛠 Redis cart (guest cart merged on login), Redis product cache
- [x] 🛠 Checkout re-checks prices and stock; one transaction creates the order + one sub-order per vendor
- [x] 🛠 Stock reservation that expires if payment never happens (delayed job + minute sweep)
- [x] 🛠 Sub-order status: placed → packed → shipped → delivered; customer can cancel before shipping
- [x] 🛠 Customer "My orders" page with timeline; vendor orders page (plus addresses and a test payment screen)
- [x] 🛠 Tests: status rules, parallel checkouts never oversell
- [x] 👤 AWS: free plan with $100 credits (unused), root MFA on, zero-spend budget set
- [ ] 👤 Oracle VM retry
- [x] ✅ Cart with items from 2 vendors → 1 order, 2 sub-orders

## Day 6 · Sat 7 Nov · Razorpay payments + split engine (brief step 6)
- [x] 🛠 `PaymentProvider` (`razorpay`, `mock`) and `PayoutProvider` (`mock`, labelled "simulated payout")
- [x] 🛠 Razorpay Order at checkout, Checkout popup (test Netbanking → Success; UPI `success@razorpay` when offered), signature check (+ capture check)
- [x] 🛠 Webhook: signature verified, safe against repeats and out-of-order events (tested locally with signed sample events; the real webhook is connected once the site is live on Day 9)
- [x] 🛠 After payment: ledger entries; each vendor's share (subtotal − commission) **held**
- [x] 🛠 Delivered → release that share → payout job pays it out; cancel → reverse the hold + real Razorpay test refund
- [x] 🛠 Vendor payout details (only last 4 digits stored); tests for split maths, escrow states and webhooks; doc 09 (payments)
- [x] 👤 Generate Razorpay **test** keys and put them in `.env` yourself (never in chat or Git)
- [ ] 👤 Oracle VM retry
- [x] ✅ Pay with real Razorpay test UPI → 2 vendor shares held → deliver → released → paid out (simulated); payment and refund visible in the Razorpay test dashboard
  - Paid with test Netbanking (UPI isn't offered on this account); payment captured and visible in the dashboard. Refunds are refused by Razorpay for this test account, dashboard included ("invalid request sent"), so the refund shows as failed and is retried hourly ([doc 09](../09-payments.md#known-limit-razorpay-test-accounts-may-refuse-refunds))

## Day 7 · Sun 8 Nov · Reviews, coupons, invoices (brief step 7, part 1)
- [x] 🛠 Reviews only from buyers whose order was delivered; rating updates product + search (+ admin hide/show; catalogue's own reviews imported)
- [x] 🛠 Coupons: platform or vendor, % or flat, minimum order, usage limits, expiry
- [x] 🛠 PDF invoice per sub-order, generated in the background, stored in S3, download link
- [x] 🛠 Tests for review rules, coupon maths, invoices
- [x] 👤 Create MongoDB Atlas M0 (Mumbai), DuckDNS name, Vercel and UptimeRobot accounts (Oracle retries ended: no capacity)
- [x] ✅ Buy with a coupon → invoice PDF downloads → leave a review

## Day 8 · Sun 8 Nov · Admin analytics & polish (brief step 7, part 2)
- [x] 🛠 Admin analytics: sales total (GMV), commission earned, orders by status, daily sales chart, top vendors/products
- [x] 🛠 Vendor earnings page (held / released / settled)
- [x] 🛠 Admin pages: vendors, commission rates, refunds, review moderation
- [x] 🛠 UI polish: loading, empty and error states; mobile layout; doc 07 (frontend)
- [x] 👤 **Hosting decision:** Oracle VM if it was created by now, otherwise the AWS fallback (EC2 t4g.small in Mumbai on free-plan credits). **Decided Sat 7 Nov: AWS** (Oracle out of capacity every day since 3 Nov)
- [ ] 👤 Create the S3 bucket and a limited access key
- [x] 🛠 Demo order history: `seed-orders` (40 orders over 30 days through the real checkout, payment, delivery, payout and refund code)
- [x] ✅ Dashboards show correct numbers for the seeded data (checked against direct database sums)

## Day 9 · Mon 9 Nov · Live deployment & performance (brief step 7, part 3)
- [ ] 🛠 `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/server-setup.sh`
- [ ] 🛠 Server (Oracle VM or AWS EC2): Docker, swap, Elasticsearch setting, ports 80/443, HTTPS via Caddy + DuckDNS
- [ ] 🛠 Backend live on the server; frontend live on Vercel; Atlas, S3, Razorpay test webhook connected
- [ ] 🛠 CI: Docker smoke test + automatic deploy job; UptimeRobot on `/health`; nightly demo reset (03:00 IST)
- [ ] 🛠 Performance: k6 search speed (with ~20k Amazon products), cache hit vs miss; one Playwright end-to-end test
- [ ] ✅ Live links run the full demo; results recorded

## Day 10 · Tue 10 Nov · Deliverables
- [ ] 🛠 Finish docs 01–14 + `openapi.yaml`, README with setup instructions, root README row
- [ ] 🛠 Test and coverage report, performance numbers in doc 12
- [ ] 🛠 Presentation outline (10 min: problem, design, challenges, results, next steps) and reflection template
- [ ] 🛠 Final bug sweep
- [ ] 👤 Next morning: open the live link and check that it's fast, search works and the demo data was reset
- [ ] 👤 Record the demo video
- [ ] ✅ Every deliverable below is ticked

---

## Deliverables checklist
- [ ] Working demo: live link + screen recording
- [ ] GitHub repo with clean commits, README and setup instructions
- [ ] Architecture diagram + data model + API docs
- [ ] Test results + performance numbers
- [ ] 10-minute presentation
- [ ] Individual reflection

## If a day slips, cut in this order
1. 20k Amazon dataset → DummyJSON-only performance numbers
2. Playwright test → manual demo script
3. Vendor coupons → platform coupons only
4. Neither Oracle nor AWS works out → fallback C (recorded demo, run locally)

## Buffer · Wed 11 – Fri 20 Nov
- [ ] Wed 11 – Fri 13: catch up on anything that slipped, then put back whatever was cut above (20k dataset first); FS-04's optional live site
- [ ] Sat 14 – Sun 15: watch the live site for two nights (uptime, nightly reset, credits used); fix what shows up
- [ ] Mon 16 – Tue 17: rehearse the 10-minute presentation twice; write the reflection
- [ ] Wed 18 – Thu 19: final read of the docs and README; re-record the demo if the app changed
- [ ] Fri 20 Nov: submit
