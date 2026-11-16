# CLAUDE.md · FS-01 ShopSphere

Multi-vendor marketplace (capstone FS-01). One cart from many stores, one payment, split per store with commission,
held until delivery. Self-contained: never share servers, files or code with FS-04.

## Tech stack

| Part | Stack |
|---|---|
| Backend (`backend/`) | Node 24, Express 5, TypeScript (strict), Zod 4, Prisma 7.10 (`prisma-client` generator → `src/generated/prisma`, git-ignored; `@prisma/adapter-pg`), ioredis, BullMQ 5, @elastic/elasticsearch 8.19, AWS SDK v3 (S3 + presigner), pdfkit, jose, pino |
| Frontend (`frontend/`) | React 19, Vite, Tailwind 4, React Router 7, TanStack Query 5 |
| Data | **PostgreSQL 17** (required by the brief; schema `backend/prisma/schema.prisma`, migrations applied by the API on start), Redis 7.4, Elasticsearch 8.19, S3 (Adobe S3Mock locally) |
| Payments | Razorpay **test mode only** (`rzp_live_` keys are refused) + own ledger/escrow; `mock` provider for local/CI; simulated payouts |
| Tests | Vitest + Supertest (backend), Vitest + Testing Library (frontend), `scripts/smoke-test.sh` (whole stack) |
| CI | `../.github/workflows/fs01-ci.yml` (repo root): backend, frontend, Docker smoke test |
| Hosting | Frontend on **Vercel** (`frontend/vercel.json` rewrites `/api/*` to the server → one origin, first-party cookies); backend on AWS EC2 t4g.small, Mumbai: `docker-compose.prod.yml` (Caddy HTTPS on `shopsphere-adarsh.duckdns.org`, `/api` → API, rest → fallback copy of the web app); `TRUST_PROXY_HOPS=2`; PostgreSQL container on the same server (`POSTGRES_PASSWORD` in the server `.env`); S3 `shopsphere-media-2026` via the EC2 role (no AWS keys). The brief requires frontend and backend deployed separately |

## Commands

```bash
# Whole stack (from FS-01/); the web app is on FRONTEND_PORT (3001 on this PC, because FS-04 holds 3000)
docker compose up -d --build
docker compose exec api node dist/scripts/seed-users.js
docker compose exec api node dist/scripts/seed-catalog.js            # --no-images keeps existing photos
docker compose exec api node dist/scripts/seed-orders.js             # 40 backdated demo orders (runs once; needs photos/active products)
docker compose exec api node dist/scripts/reindex.js                 # rebuild search behind the alias

# Backend (from backend/)
npm run dev            # API with hot reload (needs: docker compose up -d postgres redis elasticsearch s3)
npm run dev:worker
npm run lint && npm run typecheck
npm test               # unit tests, no services
npm run test:integration   # real Postgres/Redis/ES/S3; own DB shopsphere_test (created + migrated), Redis db 15, index products-test
npm run db:migrate -- --name <change>   # after editing prisma/schema.prisma; commit the migration

# Frontend (from frontend/)
npm run dev            # :5173, /api proxied to :4000
npm run lint && npm test && npm run build

# Smoke test through nginx (mock payments; DEMO_PASSWORD from .env)
DEMO_PASSWORD=... bash scripts/smoke-test.sh http://localhost:3001
PAYMENT_PROVIDER=mock docker compose up -d api worker   # temporarily, when .env says razorpay
```

## Layout

- `backend/prisma/` — schema + migrations; `src/lib/db.ts` (`prisma`, `Tx`, `nextSeq`, `isUniqueViolation`).
- `backend/src/modules/<area>/` — `*.model.ts` (row types, includes, mappers), `*.routes.ts`, pure `*-rules.ts` (unit-tested), services. Areas: auth, users, account, vendors, catalog, uploads, search, cart, orders, payments, coupons, reviews, invoices.
- `backend/src/app.ts` builds the app from `AppDeps` (tests pass fakes); `modules/context.ts` is what every router gets.
- `backend/src/worker.ts` — BullMQ queues: `search-index`, `reservation-expiry` (+ minute sweep), `payout` (refunds/payouts + hourly sweep), `invoice-pdf`.
- `frontend/src/api/*` hooks, `pages/*`, `components/*`; `test/render.tsx` has `mockApi` and fixtures.
- `docs/` — numbered topic files with prev/index/next links; specs in `docs/specs/`; tracker `docs/guides/DAY_PLAN.md`.

## Conventions that matter

- **Money is integer paise; rates are basis points.** Never floats.
- Express 5: async handlers need no try/catch. Errors: `throw new AppError(status, code, message, details)`; shape `{ error: { code, message, details } }`.
- Zod 4 `.partial()` still applies defaults: use `patchSchema()` for PATCH bodies. Query strings via `parseQuery()`.
- Multi-row writes use `inTransaction(tx => …)` (`lib/transaction.ts`, READ COMMITTED); state changes are conditional updates (`updateMany`/`updateManyAndReturn` with `where: { id, status: from }`, count 0 = lost the race).
- Ids are UUIDv7: validate route ids with `idParam()` / `entityId` before querying (a malformed uuid is a Prisma error, not "not found").
- Raw SQL sums return bigint: wrap with `Number()`. Children: products need `include: withImages`, orders `orderInclude`, sub-orders `subOrderInclude`.
- Jobs carry only ids; handlers re-read PostgreSQL and are idempotent. Ledger entries are append-only with unique `key = <type>:<part or order id>`.
- The books must balance: `payment − refund + platform_discount − platform_discount_reversal = (vendor_hold − vendor_reversal) + (commission − commission_reversal)`.
- Never query with a possibly-undefined filter value (Prisma drops `undefined` conditions, so `{ field: undefined }` matches everything).
- Cookie endpoints need `X-Requested-With: ShopSphere` (CSRF). Guest cart cookie `ss_guest`.
- Every feature: tests (unit for rules, integration for flows), smoke-test step if user-visible, and the matching `docs/` update.

## Gotchas

- Presigned S3 PUTs need `requestChecksumCalculation: "WHEN_REQUIRED"`; S3Mock ignores signatures, so the API re-checks uploads with HeadObject.
- nginx uses `resolver 127.0.0.11` + a variable `proxy_pass` so recreating the API container doesn't 502.
- Integration tests rebuild the test search index at start; `wipe()` truncates every table, Redis db 15 and the index.
- Local Postgres is on **127.0.0.1:5433** (FS-04's holds 5432). The Docker image needs `openssl` and installs Prisma's engine at build time (runtime user can't write node_modules).
- Razorpay test account refuses refunds ("invalid request sent", dashboard too): refunds show `failed` and the hourly sweep retries. Test payments: Netbanking → any bank → Success (UPI isn't offered).
- Windows: some files are CRLF; scripted edits must preserve line endings. Python needs `PYTHONUTF8=1`.
- Clean smoke-test leftovers from the local DB afterwards (users `smoke-*`, their stores/orders/ledger/reviews/invoices), then reindex.

## Rules

- Commit or push only after the user approves; end commit messages with the Co-Authored-By line.
- Keys, passwords, tokens and connection strings never go into chat or Git (`.env` is git-ignored); only test keys.
- Don't enable anything billable (Oracle PAYG, RDS, AWS upgrades) without the user deciding.

## Progress and pending (as of Tue 17 Nov 2026; deadline Fri 20 Nov, one submission)

**Done:** Days 1–9 (docs 01–11, green CI). Live: frontend https://shopsphere-fs01.vercel.app (Vercel), API
https://shopsphere-adarsh.duckdns.org (EC2 t4g.small, Ubuntu 24.04 arm64; repo at `~/Rout_Adarsh_Pradhan_Capstone_Projects`
on the server; secrets only in the server's `FS-01/.env`; compose with `-f docker-compose.prod.yml`). Auto-deploy timer
(5 min, commits whose CI passed), nightly reset (03:00 IST), UptimeRobot, Razorpay test webhook (200s), `clientIp` via
Vercel verified. k6 on live (16 Nov, 50 users): 0 errors, p95 104 ms, search p95 115 ms (`perf/results-live.json`;
measured on the MongoDB build).

**17 Nov: brief changed to PostgreSQL + Prisma.** Done on branch `fs01-postgres` (not merged, live site still MongoDB
on Atlas): whole backend, seeds, tests (94 unit, 102 integration, 62 frontend, smoke), CI, `docker-compose.prod.yml`
(postgres service), `deploy/demo-reset.sh` (pg_dump/pg_restore, tested locally), docs 03/04/05/06/08–11 + schema spec +
ER diagram. Plan: `docs/specs/05-postgres-migration-plan.md`.
**Go-live steps (with the user):** push the branch, check CI → user adds `POSTGRES_PASSWORD` to the server `.env`
**before** merging (else compose fails and the old containers keep serving) → merge to main → auto-deploy → on the
server seed users, catalog (photos re-copied under new UUID store ids), orders, reindex → `bash deploy/demo-reset.sh
--save` (old `baseline.archive.gz` is Mongo, unused) → check health/login/test purchase → re-run k6 for doc 12 →
later remove the Atlas cluster/IP rule. Old S3 photos under old store ids become unused.

**Day 10 (Tue 17 – Thu 19):** docs 12 (testing + performance), 13 (challenges, next steps; include the DB switch), 14
(setup) + `openapi.yaml`, test and coverage report, presentation outline, reflection template, bug sweep; Wed: user
records the demo video (Drive link, anyone with the link). Re-seeded orders are dated around the go-live day.

**Fri 20 Nov:** submit once: GitHub link, Vercel URL (frontend) + API URL, demo logins and the live demo password in
the form's notes (not in the README), FS-04 live link, Drive folder link.
