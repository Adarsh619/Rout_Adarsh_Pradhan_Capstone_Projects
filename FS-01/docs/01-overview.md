# 01 · Overview

[Index](README.md) · [Next: Features and roles →](02-features-and-roles.md)

## The problem

An Amazon-style marketplace has three groups of users with different needs:

- **Customers** want to search every seller at once, put products from several sellers in one cart and pay once.
- **Vendors** want to sell without building their own store, and want to be paid reliably.
- **The platform** has to keep sellers trustworthy, earn a commission and, hardest of all, **split one customer payment between several vendors**.

ShopSphere builds all three sides, with real search, a real order lifecycle and real split payments in Razorpay test mode.

## Tech stack

| Layer | Tech | Why |
|---|---|---|
| Frontend | React 19 · Vite · React Router · TanStack Query · Tailwind CSS | Fast builds, server-state caching, consistent styling |
| API | Node.js 24 LTS · Express 5 · TypeScript · Zod | Typed code for money and order logic; validated input |
| Database | PostgreSQL 17 · Prisma 7 | Required by the brief; relational orders and ledger, transactions and constraints for checkout |
| Search | Elasticsearch 8.19 | Typo-tolerant full-text search, filters, facets, sorting |
| Cache, sessions, queues | Redis 7.4 · BullMQ | Carts, refresh sessions, caching, rate limits, background jobs |
| Files | AWS S3 (Adobe S3Mock locally) | Product images and invoice PDFs through presigned URLs |
| Payments | Razorpay test mode (Orders, Checkout, webhooks, refunds) · own split-and-escrow engine · simulated vendor payouts | INR + UPI; one payment split into per-vendor shares, released on delivery |
| Infra | Docker Compose · nginx · GitHub Actions | One-command local stack; CI on every push |
| Live hosting | Vercel (frontend) · AWS EC2 t4g.small in Mumbai with Docker Compose + Caddy (backend, with PostgreSQL) · AWS S3 | Frontend and backend deployed separately; always on; the server deploys each commit that passes CI ([DevOps](11-devops.md)) |

## Scope against the brief

Every step of the brief is built, tested and live at https://shopsphere-fs01.vercel.app.

| Brief step | Where | Status |
|---|---|---|
| 1. Roles, database schema, API list | [Features and roles](02-features-and-roles.md), [Data model](05-data-model.md), [Database schema](specs/03-database-schema.md), [API reference](06-api-reference.md), [OpenAPI](openapi.yaml) | ✓ |
| 2. JWT authentication, role-based access | [Security](10-security.md) | ✓ |
| 3. Vendor onboarding, product CRUD, images to S3 | [API reference](06-api-reference.md#vendors-and-stores), [Design decisions](04-design-decisions.md#7-files-go-straight-between-the-browser-and-s3) | ✓ |
| 4. Elasticsearch search with filters and sorting | [Background jobs and search](08-background-jobs.md) | ✓ |
| 5. Cart, checkout, order lifecycle (placed, packed, shipped, delivered); Redis for cart and sessions | [API reference](06-api-reference.md#cart-guests-too), [Design decisions](04-design-decisions.md#8-redis-for-carts-sessions-cache-and-queues) | ✓ |
| 6. Razorpay test mode, split payments and commission | [Payments, escrow and payouts](09-payments.md) | ✓ Razorpay test mode; own split ledger; simulated payouts |
| 7. Reviews, coupons, PDF invoices, admin analytics; frontend and backend deployed separately | [API reference](06-api-reference.md), [DevOps](11-devops.md) | ✓ Vercel + AWS |
| Tools: React, TypeScript, Node.js, Express, PostgreSQL, Prisma, Tailwind CSS, Docker | [Tech stack](#tech-stack) | ✓ all used |

## What works

- **Customers:** search with typos, filters and facets; a cart from several stores (as a guest too); coupons; one
  checkout and one Razorpay payment for all stores; each store's part followed from placed to delivered; cancelling one
  part refunds it; invoices; reviews after delivery.
- **Vendors:** apply for a store, list products with photos, pack and ship their part of each order, see their share
  held until delivery and then paid out, store coupons, earnings.
- **Admins:** approve or suspend stores, categories and commission rates, platform coupons, orders and refunds, review
  moderation, analytics from the ledger.
- **Behind it:** background jobs for search, invoices, refunds, payouts and stock reservations; a ledger that always
  balances; 266 automated tests plus an end-to-end smoke test in CI; a server that deploys each commit that passes CI
  and resets the demo every night ([Testing and performance](12-testing-and-performance.md), [DevOps](11-devops.md)).

## Data sources

The brief needs no dataset; it suggests five optional sources of sample data. ShopSphere uses two of them:

| Source | Used | How |
|---|---|---|
| [DummyJSON](https://dummyjson.com) | ✓ | 194 products with photos and their **582 reviews** (shown as imported, never as "verified purchase") |
| [Fake Store API](https://fakestoreapi.com) | ✓ | 20 products (clothing, jewellery, electronics) |
| Amazon Reviews 2023 metadata (McAuley Lab) | — | Planned for a 20,000-product load test; dropped for time and listed as a [next step](13-challenges-and-next-steps.md#next-steps) |
| Flipkart Products (Kaggle) | — | Not needed: a manual download, and many of its photo links point at Flipkart's servers |
| Olist Brazilian E-Commerce (Kaggle) | — | Not needed: real orders, but in reais and Portuguese, and imported orders would bypass ShopSphere's own checkout and ledger |

- **A snapshot, not a live feed.** The 214 products are saved in [`backend/seed/catalog.json`](../backend/seed/catalog.json)
  (refresh with `npm run seed:snapshot`), so seeding never depends on those sites being up. Prices are converted to
  rupees; products are spread over 27 categories and 5 demo stores (plus one application waiting for approval).
- **Photos are copied into our own S3 bucket**, not hot-linked, so the live demo never breaks if a source's CDN does.
- **Order history is made by the app itself.** `seed-orders.js` places 40 orders from five demo buyers through the real
  checkout, payment (mock), delivery, payout and cancellation code, so the dashboards and the ledger are consistent.
