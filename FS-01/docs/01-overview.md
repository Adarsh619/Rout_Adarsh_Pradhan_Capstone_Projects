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
| Database | MongoDB 8 (replica set) · Mongoose | Flexible product attributes; transactions for checkout |
| Search | Elasticsearch 8.19 | Typo-tolerant full-text search, filters, facets, sorting |
| Cache, sessions, queues | Redis 7.4 · BullMQ | Carts, refresh sessions, caching, rate limits, background jobs |
| Files | AWS S3 (Adobe S3Mock locally) | Product images and invoice PDFs through presigned URLs |
| Payments | Razorpay Route (test mode) · built-in mock | INR + UPI; one payment split into per-vendor transfers |
| Infra | Docker Compose · nginx · GitHub Actions | One-command local stack; CI on every push |
| Live hosting | Vercel (frontend) · Oracle Cloud Always Free VM (backend) · MongoDB Atlas · AWS S3 | Frontend and backend deployed separately; always on |

## Scope against the brief

| Brief step | Where | Status |
|---|---|---|
| 1. Roles, database schema, API list | [Features and roles](02-features-and-roles.md), [Database schema](specs/03-database-schema.md), [API list](specs/04-api-list.md) | ✓ Day 1 |
| 2. JWT authentication, role-based access | Auth module | Day 2 |
| 3. Vendor onboarding, product CRUD, S3 images | Vendors and products modules | Day 3 |
| 4. Elasticsearch search with filters and sorting | Search module | Day 4 |
| 5. Cart, checkout, order lifecycle, Redis caching | Cart and orders modules | Day 5 |
| 6. Razorpay split payments and commission | Payments module | Day 6 |
| 7. Reviews, coupons, PDF invoices, admin analytics, separate deployment | Several modules, live hosting | Days 7–9 |

## What works today (Day 1)

- `docker compose up --build` starts MongoDB, Redis, Elasticsearch, the S3 mock, the API, the worker and the web app.
- `GET /api/v1/health` checks all four backing services; the home page shows their status.
- CI runs lint, unit tests, integration tests against real services, and a Docker smoke test.
