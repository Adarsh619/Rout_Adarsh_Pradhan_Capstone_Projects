# CLAUDE.md · FS-01 ShopSphere

Multi-vendor marketplace (capstone FS-01). One cart from many stores, one payment, split per store with commission,
held until delivery. Self-contained: never share servers, files or code with FS-04.

## Tech stack

| Part | Stack |
|---|---|
| Backend (`backend/`) | Node 24, Express 5, TypeScript (strict), Zod 4, Mongoose 9, ioredis, BullMQ 5, @elastic/elasticsearch 8.19, AWS SDK v3 (S3 + presigner), pdfkit, jose, pino |
| Frontend (`frontend/`) | React 19, Vite, Tailwind 4, React Router 7, TanStack Query 5 |
| Data | MongoDB **7.0** replica set (transactions; 8.x won't start on kernel 6.19+), Redis 7.4, Elasticsearch 8.19, S3 (Adobe S3Mock locally) |
| Payments | Razorpay **test mode only** (`rzp_live_` keys are refused) + own ledger/escrow; `mock` provider for local/CI; simulated payouts |
| Tests | Vitest + Supertest (backend), Vitest + Testing Library (frontend), `scripts/smoke-test.sh` (whole stack) |
| CI | `../.github/workflows/fs01-ci.yml` (repo root): backend, frontend, Docker smoke test |
| Hosting | AWS EC2 t4g.small, Mumbai: `docker-compose.prod.yml` (Caddy HTTPS on `shopsphere-adarsh.duckdns.org` → `/api` to the API, the rest to the web app, one origin); MongoDB Atlas M0; S3 `shopsphere-media-2026` (ap-south-1) via the EC2 role, no AWS keys. Vercel not used (cross-site cookies and shared proxy IPs) |

## Commands

```bash
# Whole stack (from FS-01/); the web app is on FRONTEND_PORT (3001 on this PC, because FS-04 holds 3000)
docker compose up -d --build
docker compose exec api node dist/scripts/seed-users.js
docker compose exec api node dist/scripts/seed-catalog.js            # --no-images keeps existing photos
docker compose exec api node dist/scripts/seed-orders.js             # 40 backdated demo orders (runs once; needs photos/active products)
docker compose exec api node dist/scripts/reindex.js                 # rebuild search behind the alias

# Backend (from backend/)
npm run dev            # API with hot reload (needs: docker compose up -d mongo redis elasticsearch s3)
npm run dev:worker
npm run lint && npm run typecheck
npm test               # unit tests, no services
npm run test:integration   # real MongoDB/Redis/ES/S3; own DB shopsphere_test, Redis db 15, index products-test

# Frontend (from frontend/)
npm run dev            # :5173, /api proxied to :4000
npm run lint && npm test && npm run build

# Smoke test through nginx (mock payments; DEMO_PASSWORD from .env)
DEMO_PASSWORD=... bash scripts/smoke-test.sh http://localhost:3001
PAYMENT_PROVIDER=mock docker compose up -d api worker   # temporarily, when .env says razorpay
```

## Layout

- `backend/src/modules/<area>/` — `*.model.ts`, `*.routes.ts`, pure `*-rules.ts` (unit-tested), services. Areas: auth, users, account, vendors, catalog, uploads, search, cart, orders, payments, coupons, reviews, invoices.
- `backend/src/app.ts` builds the app from `AppDeps` (tests pass fakes); `modules/context.ts` is what every router gets.
- `backend/src/worker.ts` — BullMQ queues: `search-index`, `reservation-expiry` (+ minute sweep), `payout` (refunds/payouts + hourly sweep), `invoice-pdf`.
- `frontend/src/api/*` hooks, `pages/*`, `components/*`; `test/render.tsx` has `mockApi` and fixtures.
- `docs/` — numbered topic files with prev/index/next links; specs in `docs/specs/`; tracker `docs/guides/DAY_PLAN.md`.

## Conventions that matter

- **Money is integer paise; rates are basis points.** Never floats.
- Express 5: async handlers need no try/catch. Errors: `throw new AppError(status, code, message, details)`; shape `{ error: { code, message, details } }`.
- Zod 4 `.partial()` still applies defaults: use `patchSchema()` for PATCH bodies. Query strings via `parseQuery()`.
- Multi-document writes use `inTransaction()` (`lib/transaction.ts`); state changes are conditional updates (`{ _id, status: from }`) so races lose cleanly.
- Jobs carry only ids; handlers re-read MongoDB and are idempotent. Ledger entries are append-only with unique `key = <type>:<part or order id>`.
- The books must balance: `payment − refund + platform_discount − platform_discount_reversal = (vendor_hold − vendor_reversal) + (commission − commission_reversal)`.
- Never query with a possibly-undefined filter value (`{ field: undefined }` matches everything).
- Cookie endpoints need `X-Requested-With: ShopSphere` (CSRF). Guest cart cookie `ss_guest`.
- Every feature: tests (unit for rules, integration for flows), smoke-test step if user-visible, and the matching `docs/` update.

## Gotchas

- Presigned S3 PUTs need `requestChecksumCalculation: "WHEN_REQUIRED"`; S3Mock ignores signatures, so the API re-checks uploads with HeadObject.
- nginx uses `resolver 127.0.0.11` + a variable `proxy_pass` so recreating the API container doesn't 502.
- Integration tests rebuild the test search index at start; `wipe()` clears DB, Redis db 15 and the index.
- Razorpay test account refuses refunds ("invalid request sent", dashboard too): refunds show `failed` and the hourly sweep retries. Test payments: Netbanking → any bank → Success (UPI isn't offered).
- Windows: some files are CRLF; scripted edits must preserve line endings. Python needs `PYTHONUTF8=1`.
- Clean smoke-test leftovers from the local DB afterwards (users `smoke-*`, their stores/orders/ledger/reviews/invoices), then reindex.

## Rules

- Commit or push only after the user approves; end commit messages with the Co-Authored-By line.
- Keys, passwords, tokens and connection strings never go into chat or Git (`.env` is git-ignored); only test keys.
- Don't enable anything billable (Oracle PAYG, paid Atlas tiers, AWS upgrades) without the user deciding.

## Progress and pending (as of Sat 14 Nov 2026; deadline Fri 20 Nov, one submission)

**Done:** Days 1–8 built, tested, documented (docs 01–10) and green on CI; last FS-01 commits `c3b9b4d`, `2da4515`,
`c2d00e3`, `07d0345`, `84595bf` (8 Nov). Hosting decided: AWS (see stack table). Accounts ready: MongoDB Atlas M0,
DuckDNS, Vercel, AWS (free plan, $100 credits, MFA, budget alert).

**Waiting on the user:**
- S3 bucket `shopsphere-media-2026` (named; user creating it): public read only for `products/*` and `stores/*` (`invoices/*` stays private). CORS for `https://shopsphere-adarsh.duckdns.org`.
- IAM policy `shopsphere-s3-access` (PutObject, GetObject, DeleteObject on the bucket; ListBucket for the HeadBucket health ping) and role `shopsphere-ec2-role` for EC2. No IAM user or access key.
- DuckDNS subdomain: `shopsphere-adarsh`. Finish UptimeRobot signup.

**Day 9 (deploy, Sat 14 – Sun 15):**
- Code (written 14 Nov): empty S3 keys → SDK default credentials (`s3Credentials()`); `docker-compose.prod.yml`, `deploy/Caddyfile`, `deploy/server-setup.sh`, `deploy/production.env.example`.
- Launch EC2 t4g.small (Ubuntu arm64, Mumbai) with the role; security group 22 (user's IP only), 80, 443. DuckDNS → server IP; Caddy HTTPS.
- Atlas: allow the server IP. S3 CORS for the DuckDNS origin. Seed users, catalog, orders on Atlas.
- Razorpay test webhook + secret; UptimeRobot on `/api/v1/health`.
- CI auto-deploy; nightly demo reset at 03:00 IST; k6 load test (20k-product dataset can be dropped); one Playwright end-to-end test (can be dropped).
- Check whether the refused ₹3,399 test refund (order SS-2026-000010) went through after the 9 Nov settlement.

**Day 10 (Mon 16 – Thu 19):** docs 11–14 (DevOps/CI, testing and performance, challenges and next steps, setup) +
`openapi.yaml`, test and coverage report, presentation outline, reflection template, bug sweep; user records the demo
video (Drive link, anyone with the link). Re-date the remaining days in `docs/guides/DAY_PLAN.md`.

**Fri 20 Nov:** submit once: GitHub link, live URL `https://shopsphere-adarsh.duckdns.org`, FS-04 live link in notes, Drive folder link.
