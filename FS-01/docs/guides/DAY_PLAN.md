# FS-01 · ShopSphere: 10-Day Build Tracker

Tick a box (`[x]`) when an item is done. Each day ends with something that works, a commit (approved first), and the matching doc.
Dates assume you start **Tue 3 Nov 2026** and work every day; shift them if you start later. Final deadline: **20 Nov 2026**.

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

## Day 5 · Sat 7 Nov · Cart, checkout, order lifecycle (brief step 5)
- [ ] 🛠 Redis cart (guest cart merged on login), Redis product cache
- [ ] 🛠 Checkout re-checks prices and stock; one transaction creates the order + one sub-order per vendor
- [ ] 🛠 Stock reservation that expires if payment never happens
- [ ] 🛠 Sub-order status: placed → packed → shipped → delivered; customer can cancel before shipping
- [ ] 🛠 Customer "My orders" page with timeline; vendor orders page
- [ ] 🛠 Tests: status rules, parallel checkouts never oversell
- [ ] 👤 Oracle VM retry
- [ ] ✅ Cart with items from 2 vendors → 1 order, 2 sub-orders

## Day 6 · Sun 8 Nov · Razorpay payments + split engine (brief step 6)
- [ ] 🛠 `PaymentProvider` (`razorpay`, `mock`) and `PayoutProvider` (`mock`, labelled "simulated payout")
- [ ] 🛠 Razorpay Order at checkout, Checkout popup (UPI `success@razorpay`), signature check
- [ ] 🛠 Webhook: signature verified, safe against repeats and out-of-order events
- [ ] 🛠 After payment: ledger entries; each vendor's share (subtotal − commission) **held**
- [ ] 🛠 Delivered → release that share → payout job pays it out; cancel → reverse the hold + real Razorpay test refund
- [ ] 🛠 Vendor payout details (only last 4 digits stored); tests for split maths, escrow states and webhooks; doc 09 (payments)
- [ ] 👤 Add Razorpay test keys to `.env`; Oracle VM retry
- [ ] ✅ Pay with real Razorpay test UPI → 2 vendor shares held → deliver → released → paid out (simulated); payment and refund visible in the Razorpay test dashboard

## Day 7 · Mon 9 Nov · Reviews, coupons, invoices (brief step 7, part 1)
- [ ] 🛠 Reviews only from buyers whose order was delivered; rating updates product + search
- [ ] 🛠 Coupons: platform or vendor, % or flat, minimum order, usage limits, expiry
- [ ] 🛠 PDF invoice per sub-order, generated in the background, stored in S3, download link
- [ ] 🛠 Tests for review rules, coupon maths, invoices
- [ ] 👤 Oracle VM retry
- [ ] ✅ Buy with a coupon → invoice PDF downloads → leave a review

## Day 8 · Tue 10 Nov · Admin analytics & polish (brief step 7, part 2)
- [ ] 🛠 Admin analytics: sales total (GMV), commission earned, orders by status, daily sales chart, top vendors/products
- [ ] 🛠 Vendor earnings page (held / released / settled)
- [ ] 🛠 Admin pages: vendors, commission rates, refunds, review moderation
- [ ] 🛠 UI polish: loading, empty and error states; mobile layout; doc 07 (frontend)
- [ ] 👤 Create accounts: AWS (S3 bucket in Mumbai + limited access key), MongoDB Atlas M0, DuckDNS name, Vercel, UptimeRobot
- [ ] ✅ Dashboards show correct numbers for the seeded data

## Day 9 · Wed 11 Nov · Live deployment & performance (brief step 7, part 3)
- [ ] 🛠 `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/server-setup.sh`
- [ ] 🛠 Oracle VM: Docker, Elasticsearch setting, ports 80/443, HTTPS via Caddy + DuckDNS
- [ ] 🛠 Backend live on Oracle; frontend live on Vercel; Atlas, S3, Razorpay webhook connected
- [ ] 🛠 CI: Docker smoke test + automatic deploy job; UptimeRobot on `/health`; nightly demo reset (03:00 IST)
- [ ] 🛠 Performance: k6 search speed (with ~20k Amazon products), cache hit vs miss; one Playwright end-to-end test
- [ ] 👤 If Oracle still has no capacity → fallback B (Render + keep-alive ping), else C (recording)
- [ ] ✅ Live links run the full demo; results recorded

## Day 10 · Thu 12 Nov · Deliverables
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
4. Oracle VM unavailable → fallback B (Render), then C (recording)

Spare time: Days 8 and 10 have some slack, and 13–20 Nov is buffer before the deadline.
