# MongoDB → PostgreSQL + Prisma migration plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ShopSphere's backend stores everything in PostgreSQL through Prisma, as the updated brief requires, with the
same API, the same behaviour and every test green; the live site runs on it before Fri 20 Nov.

**Architecture:** Prisma replaces Mongoose in the data layer only. Routes, rules (`*-rules.ts`), the API contract, the
frontend, Redis (cart, sessions, queues, cache), Elasticsearch, S3 and Razorpay don't change. Each Mongoose model becomes
a Prisma model; embedded lists become child tables; embedded objects become prefixed columns. Multi-row writes use
`prisma.$transaction`; state changes stay conditional (`updateMany where { id, status: from }` → `count === 1`).

**Tech stack:** PostgreSQL 17 (`postgres:17-alpine`), Prisma **7.10.1** (stable; 8.0 is still a release candidate) with
the `prisma-client` generator and `@prisma/adapter-pg`, `pg`.

**Spec:** the brief's tools list (React, TypeScript, Node.js, Express, **PostgreSQL**, **Prisma**, Tailwind CSS, Docker)
and [03-database-schema.md](03-database-schema.md) (rewritten in Task 9).

## Global constraints

- Money stays integer paise (`Int`), rates basis points (`Int`). Never `Float`/`Decimal` for money.
- Ids: `String @id @default(uuid(7)) @db.Uuid`, time-ordered, so "sort by id" still means "sort by creation".
- Times: `DateTime @db.Timestamptz(3)`.
- Enums: Prisma enums with the current string values (`pending_payment`, `awaiting_payment`, …), so API output is unchanged.
- API responses keep the exact current shapes (`id` strings, ISO dates, `null` for missing). The frontend isn't touched.
- Ledger stays append-only with unique `key`; the books-balance identity in CLAUDE.md must still hold.
- FS-01 never shares a database server with FS-04 (FS-04 uses Neon).
- Nothing billable: no RDS. Live Postgres runs as a container on the existing EC2 server.

## Schema decisions

| Mongo shape | Postgres |
|---|---|
| `users.addresses[]` | `addresses` table (`userId`, max 5 still enforced in code) |
| `products.images[]` | `product_images` (`productId`, `position`, `key`, `alt`) |
| `products.attributes` (Map) | `attributes Json @default("{}")` |
| `orders.items[]` + `subOrders.items[]` (same lines twice) | one `order_lines` table with `orderId` **and** `subOrderId` |
| `orders.shippingAddress` (snapshot) | `shippingAddress Json`: an immutable copy taken at checkout |
| `orders.coupon`, `orders.payment` | prefixed columns: `couponId`, `couponCode`, … `paymentProvider`, `paymentStatus`, … |
| `subOrders.statusHistory[]` | `sub_order_events` (`subOrderId`, `status`, `at`, `byUserId`, `byRole`, `note`) |
| `subOrders.tracking/payout/refund`, `vendors.payout` | prefixed columns (`payoutStatus`, `refundStatus`, …) |
| `counters` (`$inc` upsert) | `counters(id text pk, seq int)`; `INSERT … ON CONFLICT DO UPDATE SET seq = seq + 1 RETURNING seq` |
| Partial unique indexes (sku, providerOrderId, review per user) | Plain `@@unique`: Postgres treats NULLs as distinct, which gives the same effect |

## Review focus

1. **Two checkouts racing for the last unit:** stock decrement is `updateMany where { id, stock: { gte: qty } }`; the loser gets `409 out_of_stock`, never negative stock (orders integration test).
2. **The same webhook delivered twice or out of order:** unique `(provider, eventId)` plus conditional status updates; P2002 is treated as "already handled" (payments test).
3. **Invalid ids in URLs:** a non-UUID id must give `400`/`404`, never a Prisma 500 (`entityId` validator, catalog test).
4. **Cancelling one part of a multi-store order:** refund, commission reversal and vendor reversal written in one transaction; the books still balance (payments test).
5. **The analytics numbers:** sums match the seeded data exactly after the rewrite to `groupBy`/SQL (analytics test).

## Tasks

Estimates are for active work. Each task ends with `npm run lint && npm run typecheck && npm test` green, plus the
integration tests of the converted modules.

### Task 1 · Foundation (~1 h)
**Files:** `backend/prisma/schema.prisma`, `backend/prisma.config.ts`, `backend/prisma/migrations/*`, `backend/src/lib/db.ts`
(replaces `lib/mongo.ts`), `lib/transaction.ts`, `lib/health.ts`, `config/env.ts` (`DATABASE_URL` replaces `MONGO_URL`),
`middleware/validate.ts` (`entityId = z.uuid()` replaces `objectId`), `docker-compose.yml` (`postgres` replaces `mongo`),
`Dockerfile` (`prisma generate` in the build stage; `prisma/` copied to the runtime image), `package.json` scripts
`db:migrate` (`prisma migrate dev`), `db:deploy` (`prisma migrate deploy`), `postinstall: prisma generate`.
**Interfaces produced:** `prisma: PrismaClient`, `connectDb(url)`, `disconnectDb()`, `pingDb()`,
`inTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>`, `type Tx = Prisma.TransactionClient`,
`nextSeq(name: string, tx?: Tx): Promise<number>`, `isUniqueViolation(e): boolean` (P2002).
- [ ] Write all models in `schema.prisma` (table names via `@@map` snake_case plural), create the first migration.
- [ ] Unit test: `nextSeq` formats stay `SS-2026-000001` / `INV-2026-000001` (existing tests keep passing).
- [ ] Health check reports `postgres` instead of `mongo`.

### Task 2 · Users, auth, account, vendors (~1 h)
**Files:** `modules/users/*`, `auth/*`, `account/address.routes.ts`, `vendors/*`, `middleware/auth.ts`, `scripts/seed-users.ts`,
integration `auth.test.ts`, `vendors.test.ts`. Mappers `toPublicUser`, `toAddress`, `toPublicStore`, `toOwnStore` take Prisma rows.

### Task 3 · Catalog, uploads, search, reviews, coupons (~1.5 h)
**Files:** `catalog/*`, `uploads/*`, `search/search-indexer.ts` + `search-sync.ts`, `reviews/*`, `coupons/*`,
`scripts/seed-catalog.ts`, `scripts/reindex.ts`, integration `catalog`, `search`, `reviews-coupons-invoices` (reviews and coupons part).

### Task 4 · Orders, payments, ledger, webhooks, invoices (~2.5 h)
**Files:** `orders/*` (checkout, reservations, lifecycle), `payments/*` (ledger `record(entries, tx)`, money jobs, webhooks),
`invoices/*`, `cart/cart-view.ts`, `scripts/seed-orders.ts`, integration `orders`, `payments`, invoices part.

### Task 5 · Analytics (~45 min)
**Files:** `analytics/*` via `groupBy` / `$queryRaw`; integration `analytics.test.ts` (numbers unchanged).

### Task 6 · Remove Mongo, CI, smoke test (~1 h)
- [ ] `npm uninstall mongoose`; `grep -ri mongo backend/src` returns nothing.
- [ ] CI: `postgres:17-alpine` service container + `prisma migrate deploy` before integration tests; smoke job unchanged.
- [ ] `scripts/smoke-test.sh` passes against the local stack. Commit, push the branch, CI green.

### Task 7 · Live cutover (~45 min, with the user)
- [ ] `docker-compose.prod.yml`: `postgres` service (`shared_buffers=64MB`, volume, health check), `DATABASE_URL` built from
      `POSTGRES_PASSWORD` in the server's `.env`; the API runs `prisma migrate deploy` on start.
- [ ] `deploy/demo-reset.sh`: `pg_dump -Fc` / `pg_restore --clean --if-exists` inside the postgres container.
- [ ] User: add `POSTGRES_PASSWORD` to the server's `.env` **before** the merge (otherwise auto-deploy's build fails and the old
      Mongo containers keep serving). Merge → auto-deploy → seed users, catalog, orders → reindex → `demo-reset.sh --save`.
- [ ] Check: health, sign-in through Vercel, a Razorpay test purchase, invoice, webhook 200. Remove the Atlas IP rule later.

### Task 8 · Docs (~1 h)
`docs/05-data-model.md` (ER diagram, `erDiagram`), `specs/03-database-schema.md`, decision in `04` ("PostgreSQL + Prisma, as the
brief requires; previously MongoDB"), edits to `01, 03, 06, 08, 09, 10, 11`, README tech table, `assets/architecture.mmd`,
CLAUDE.md stack and commands, DAY_PLAN.

**Total: about 9–10 hours of work**, then Day 10 deliverables.
