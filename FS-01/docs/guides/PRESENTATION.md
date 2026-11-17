# Presentation outline · ShopSphere (10 minutes)

[Index](../README.md) · [Day plan](DAY_PLAN.md)

The brief asks for a 10-minute final presentation covering **problem, design, challenges, results and next steps**.
This outline has 10 slides, a timing for each, what goes on the slide, and what to say. Speaking notes are written in
plain sentences you can put into your own words; rehearse with a timer twice.

**Before you start:** open https://shopsphere-fs01.vercel.app in a browser tab (signed out), a second tab signed in as
the vendor, and have the demo video ready as a backup in case the network fails.

| # | Slide | Covers | Time | Running |
|---|---|---|---|---|
| 1 | ShopSphere | Title | 0:20 | 0:20 |
| 2 | The problem | Problem | 1:00 | 1:20 |
| 3 | What I built | Problem → solution | 0:50 | 2:10 |
| 4 | Architecture | Design | 1:10 | 3:20 |
| 5 | How the money moves | Design | 1:10 | 4:30 |
| 6 | Live demo | Results | 2:00 | 6:30 |
| 7 | Challenges | Challenges | 1:20 | 7:50 |
| 8 | Results in numbers | Results | 0:50 | 8:40 |
| 9 | Limits and next steps | Next steps | 0:50 | 9:30 |
| 10 | What I learned · thank you | Close | 0:30 | 10:00 |

---

## 1 · ShopSphere (0:20)

**On the slide:** "ShopSphere: a multi-vendor marketplace" · your name · capstone FS-01 · the live link
`shopsphere-fs01.vercel.app`.

**Say:** "ShopSphere is an Amazon-style marketplace where many stores sell, customers buy from several of them in one
checkout, and the platform splits every payment and keeps a commission. It's live; I'll show it in a few minutes."

## 2 · The problem (1:00)

**On the slide:** three columns.
- **Customers:** search every store at once; one cart, one payment.
- **Vendors:** sell without building a website; get paid reliably.
- **The platform:** trust the sellers, earn a commission, and **split one payment between several stores**.

**Say:** "The hard part isn't the shop pages; it's the money. One customer pays once for items from three stores. Each
store must get its share minus commission, but only once its part is delivered, and if one store's part is cancelled,
only that part is refunded. And all of this has to stay correct when two people buy the last item at the same moment,
or when the payment provider reports the same payment twice."

## 3 · What I built (0:50)

**On the slide:** three role boxes with 3–4 bullets each (from [Overview](../01-overview.md#what-works)):
customer (search with typos, multi-store cart, coupons, one payment, track each store's parcel, reviews, invoices) ·
vendor (store application, products with photos, pack/ship/deliver, earnings held then paid) · admin (approve stores,
commission rates, refunds, review moderation, analytics).

**Say:** "Every step of the brief is built: roles and JWT sign-in, vendor onboarding with S3 photo uploads,
Elasticsearch search, cart and order lifecycle with Redis, Razorpay test-mode split payments, and reviews, coupons,
PDF invoices and analytics. Frontend and backend are deployed separately."

## 4 · Architecture (1:10)

**On the slide:** the [architecture diagram](../assets/architecture.png), plus the stack in one line:
React 19 + Tailwind · Node 24, Express 5, TypeScript · PostgreSQL 17 + Prisma · Redis · Elasticsearch · S3 ·
Razorpay test mode · Docker.

**Say (point at the diagram):**
- "The React app is on Vercel. Vercel forwards `/api` to my server, so the browser sees one site and the sign-in cookie
  works everywhere, Safari included."
- "The server is an AWS machine in Mumbai running everything in Docker: the Express API, a background worker,
  PostgreSQL, Redis and Elasticsearch, behind Caddy for HTTPS."
- "PostgreSQL is the source of truth. Elasticsearch is a search copy kept in step by background jobs, so a search
  outage never stops selling. Redis holds carts, sessions, cache and job queues."
- "Photos go straight from the browser to S3 with signed links; the server has no AWS keys at all, it uses an IAM role."

## 5 · How the money moves (1:10)

**On the slide:** a simple flow and one worked example (from [Data model](../05-data-model.md#money-example)):

```
Customer pays ₹1,400 once  →  split per store: commission + vendor share
vendor share: HELD  →  delivered: RELEASED  →  PAID OUT        (cancelled: REVERSED + refunded)
```

Example: ₹1,000 phone case (store A, 10%) + ₹500 cable (store B, 8%), coupon −₹100 paid by the platform →
A gets ₹900, B gets ₹460, platform keeps ₹40.

**Say:** "Razorpay Route, which splits payments for you, isn't available to unregistered businesses. So I collect one
real Razorpay test payment and do the split myself in an append-only ledger: every movement is a row that's never edited.
Each store's share is held until delivery, like escrow. The ledger has a rule the tests check after every scenario:
money in minus refunds equals vendor shares plus commission, to the paisa. All money is stored as whole paise, never
as decimals."

## 6 · Live demo (2:00)

Do it live on https://shopsphere-fs01.vercel.app; if the network is slow, play the matching part of the video.

| Time | Do | Say |
|---|---|---|
| 0:00 | Search **"iphne"** (typo) | "Elasticsearch fixes the typo and shows filters with counts." |
| 0:15 | Add an iPhone charger and a lipstick (two stores) to the cart; apply **WELCOME10** | "One cart, two stores; the coupon is capped at ₹200." |
| 0:35 | Checkout → **Pay** (Razorpay test: Netbanking → Success) | "One payment for both stores; stock was held for 15 minutes while I paid." |
| 1:00 | Order page: two parts, invoice links | "Each store ships its own part; invoices are made in the background." |
| 1:15 | Vendor tab: **Orders to ship** → mark packed → shipped (tracking) → delivered | "Delivery releases the store's share; it's paid out a second later." |
| 1:40 | Admin: **Analytics** | "Sales, commission and every rupee still held for stores, straight from the ledger." |

## 7 · Challenges (1:20)

**On the slide:** four short rows (details in [Challenges](../13-challenges-and-next-steps.md)):

| Challenge | What I did |
|---|---|
| The brief switched the database to PostgreSQL + Prisma 3 days before the deadline | Wrote a migration plan, kept the API identical, and the same 266 tests passed before and after; live the same day |
| Two shoppers, one last unit | Conditional updates inside one transaction: the loser rolls back; a test races 6 shoppers for 3 units |
| Same payment reported twice, or the customer closes the tab | Popup and webhook can arrive in any order; each is handled exactly once |
| No free server could run Elasticsearch | Oracle had no capacity for a week → AWS Mumbai on free credits, pull-based auto-deploy |

**Say:** "The biggest one was the database change. Because the money rules were in pure functions and the tests went
through the HTTP API rather than the database, I could swap MongoDB for PostgreSQL in a day without changing what the
app does: same tests, same results, and the books still balanced."

## 8 · Results in numbers (0:50)

**On the slide:** big numbers (from [Testing and performance](../12-testing-and-performance.md)):
- **266** automated tests (97 unit, 104 integration against real databases, 65 frontend) + an end-to-end smoke test, in CI on every push
- **93.5%** backend line coverage · **83%** frontend
- Load test on the live site, 50 shoppers: **0 errors** in 5,403 requests, **p95 110 ms** (search 122 ms)
- Live since 14 Nov; deploys itself after CI passes; demo resets every night

**Say:** "These run on every push, and the server only deploys a commit whose tests passed. A final bug sweep found six
small issues, mostly screens that didn't refresh after background work, and each was fixed with a test."

## 9 · Limits and next steps (0:50)

**On the slide:** two columns.
- **Limits of v1:** simulated vendor payouts · Razorpay's test account refuses refunds (retried hourly) · no email or
  password reset · tested at 214 products.
- **Next:** real payouts with Razorpay Route · email notifications · GST and shipping charges · a 20,000-product load
  test with the Amazon Reviews 2023 data · error tracking.

**Say:** "Payouts are the one simulated piece, behind an interface, so a real provider plugs in without touching the
ledger."

## 10 · What I learned · thank you (0:30)

**On the slide:** two or three lessons in your own words (see your reflection), the live link and the GitHub link.

**Say (example, make it yours):** "I learned to design for the unhappy paths first: races, duplicate events, refunds
that fail, because that's where marketplaces lose money. Thank you; happy to take questions."

---

## Likely questions

| Question | Short answer |
|---|---|
| Why not Razorpay Route for the split? | Not available to an unregistered business; the ledger does the split, payouts sit behind an interface so Route can replace the simulated driver. ([Design decisions](../04-design-decisions.md)) |
| How do you stop overselling? | Stock is taken in the checkout transaction with `UPDATE … WHERE stock >= qty`; the loser matches no row and rolls back. Tested with 6 shoppers for 3 units. |
| What if the webhook arrives before the popup's callback? | Both paths are idempotent: confirmation only happens from `pending_payment`, and each webhook event id is stored once. On the live site the webhook actually confirmed the test order first. |
| Why both PostgreSQL and Elasticsearch? | PostgreSQL is the truth (transactions, constraints); Elasticsearch gives typo-tolerant search and facets. A background job keeps them in step; the index can be rebuilt any time with no downtime. |
| Why did you switch from MongoDB? | The brief's required tools changed to PostgreSQL + Prisma; the data is relational anyway (orders, lines, ledger). |
| How is the money kept correct? | Integer paise, an append-only ledger with unique keys (a retried job can't book twice), and a balance rule checked by the tests. |
| Is it secure? | bcrypt passwords, 15-minute access tokens with rotating refresh cookies (reuse signs out everywhere), roles on every route, rate limits, CSRF header, signed Razorpay webhooks, private invoices with 5-minute links, no AWS keys. ([Security](../10-security.md)) |
| How does it deploy? | Vercel builds the frontend; the server checks GitHub every 5 minutes and deploys the newest commit whose CI passed. |
| What would break first at scale? | One 2 GB server: Elasticsearch and PostgreSQL would move to their own machines first ([next steps](../13-challenges-and-next-steps.md#next-steps)). |
| What did you own? | Everything in FS-01: design, backend, frontend, tests, deployment and docs (say this in your own words). |
