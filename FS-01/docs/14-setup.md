# 14 · Setup

[← Challenges and next steps](13-challenges-and-next-steps.md) · [Index](README.md)

How to run ShopSphere on your own computer, try it with the demo data, develop on it and run the tests. Putting it on
a server is covered in [DevOps](11-devops.md#server-setup-from-nothing).

## 1. What you need

| Tool | Version | Needed for |
|---|---|---|
| **Docker Desktop** (Windows / macOS) or Docker Engine + Compose v2 (Linux) | any recent | Everything: the whole stack runs in containers. Give Docker **at least 4 GB of memory** (Elasticsearch needs it) |
| Git | any | Getting the code |
| Node.js | **24** | Only for developing or running the tests outside Docker |
| A Razorpay account in **test mode** | — | Optional: the built-in `mock` payment screen needs no account |

Ports used on your computer: **3000** (web app), 4000 (API), 5433 (PostgreSQL), 6379 (Redis), 9200 (Elasticsearch),
9090 (S3 mock). All except the web app listen on `127.0.0.1` only.

## 2. Run it (about 5 minutes)

```bash
git clone https://github.com/Adarsh619/Rout_Adarsh_Pradhan_Capstone_Projects.git
cd Rout_Adarsh_Pradhan_Capstone_Projects/FS-01
cp .env.example .env            # Windows PowerShell: copy .env.example .env
docker compose up -d --build    # first build takes a few minutes
```

When it's up, http://localhost:3000 shows the shop with a status badge for every service, and
http://localhost:3000/api/v1/health answers `{"status":"ok","services":{"postgres":"up",…}}`.
The API creates the database tables itself on start (`prisma migrate deploy`).

**Port 3000 taken?** Set `FRONTEND_PORT=3001` and `CORS_ORIGINS=http://localhost:3001` in `.env`, then run
`docker compose up -d` again.

## 3. Load the demo data

```bash
docker compose exec api node dist/scripts/seed-users.js      # admin, vendor and customer accounts
docker compose exec api node dist/scripts/seed-catalog.js    # 27 categories, 5 stores, 214 products, photos, reviews, 3 coupons
docker compose exec api node dist/scripts/seed-orders.js     # optional: 40 demo orders over the last 30 days (for the dashboards)
```

The catalogue comes from a committed snapshot (`backend/seed/catalog.json`), so seeding doesn't depend on any outside
site except for downloading the photos (about a minute the first time; `--no-images` skips them, and products then
stay drafts). Every demo password is `DEMO_PASSWORD` from `.env`.

| Sign in as | Role | Try |
|---|---|---|
| `customer@shopsphere.test` | Customer | Fill a cart from two stores, apply `WELCOME10`, check out, pay on the test screen, follow the order, cancel one store's part to see the refund |
| `vendor@shopsphere.test` | Vendor (Vikram Electronics) | Add products with photos, add a payout account, pack → ship → deliver paid orders, watch the share go held → paid out |
| `admin@shopsphere.test` | Admin | Approve Kavya Handicrafts' waiting application, analytics, orders and refunds, commission rates, coupons, hide a review |

Demo coupons: `WELCOME10` (10% off up to ₹200 on orders over ₹499), `FLAT100` (₹100 off ₹1,000+), `VIKRAM5` (5% off
Vikram Electronics' items).

## 4. Settings (`.env`)

Every value in [`.env.example`](../.env.example) has a working local default; you only need to change these:

| Setting | Default | Change it when |
|---|---|---|
| `FRONTEND_PORT`, `CORS_ORIGINS` | 3000 | Port 3000 is taken |
| `PAYMENT_PROVIDER` | `mock` | You want the real Razorpay test checkout: set `razorpay` and the two keys below |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | empty | Razorpay Dashboard → **Test Mode** → API Keys. Live keys (`rzp_live_…`) are refused |
| `RAZORPAY_WEBHOOK_SECRET` | empty | Only on a server with a public address (Razorpay must reach the webhook) |
| `DEMO_PASSWORD` | `ShopSphere-demo-2026` | You want a different demo password (run `seed-users.js` again) |
| `POSTGRES_PASSWORD` | `shopsphere` | Never needed locally (the database only listens on `127.0.0.1`) |

With Razorpay test mode, pay with **Netbanking → any bank → Success** (cards and UPI depend on the test account).
Never put real keys or passwords in Git; `.env` is git-ignored.

## 5. Developing with hot reload

Keep the databases in Docker and run the code on your computer:

```bash
docker compose stop api worker web                  # if the full stack is running
docker compose up -d postgres redis elasticsearch s3

cd backend
# Outside Docker, file storage defaults to real AWS S3: point it at the local mock instead (Git Bash / macOS / Linux;
# in PowerShell use $env:S3_ENDPOINT="http://localhost:9090" and so on).
export S3_ENDPOINT=http://localhost:9090 S3_PUBLIC_ENDPOINT=http://localhost:9090 S3_CREATE_BUCKET=true
npm install                 # also generates the Prisma client
npx prisma migrate deploy   # create the tables (the API container does this itself)
npm run dev                 # API on http://localhost:4000, restarts on save
npm run dev:worker          # in a second terminal: background jobs

cd ../frontend
npm install
npm run dev                 # app on http://localhost:5173 (/api is forwarded to :4000)
```

To seed from your computer instead of the container: `npm run seed:users`, `npm run seed:catalog`,
`npm run seed:orders`, in the same terminal (they read `DEMO_PASSWORD` and the storage settings above from the
environment). Everything else (database, Redis, Elasticsearch) already defaults to the local containers.

**Changing the database:** edit `backend/prisma/schema.prisma`, then `npm run db:migrate -- --name <what-changed>`.
That creates a migration in `backend/prisma/migrations/` and applies it; commit it, and the API applies it everywhere
else on its next start.

## 6. Running the tests

```bash
cd backend
npm run lint && npm run typecheck
npm test                    # unit tests: no services needed
npm run test:integration    # needs: docker compose up -d postgres redis elasticsearch s3
npm run test:coverage       # unit + integration, with coverage

cd ../frontend
npm run lint && npm test && npm run build

# the whole stack, end to end (from FS-01/, with PAYMENT_PROVIDER=mock)
DEMO_PASSWORD=ShopSphere-demo-2026 bash scripts/smoke-test.sh http://localhost:3000
```

Integration tests use their own database (`shopsphere_test`, created and migrated automatically), Redis database 15
and their own search index, so they never touch your demo data. More in [Testing and performance](12-testing-and-performance.md).

## 7. Common problems

| Symptom | Fix |
|---|---|
| Elasticsearch keeps restarting | Give Docker more memory (4 GB+). On Linux also: `sudo sysctl -w vm.max_map_count=262144` |
| `port is already allocated` | Another app uses that port. For the web app set `FRONTEND_PORT`; PostgreSQL already uses 5433 to avoid a local 5432 |
| The shop is empty | Run the seed scripts (section 3). Products seeded with `--no-images` stay drafts |
| Search finds nothing after changing data by hand | `docker compose exec api node dist/scripts/reindex.js` |
| `429 rate_limited` after many sign-ins | Wait 15 minutes, or clear the counters: `docker compose exec redis redis-cli --scan --pattern 'rl:*' \| xargs docker compose exec -T redis redis-cli del` |
| The smoke test's payment step answers 404 | `PAYMENT_PROVIDER` is `razorpay`; run it with `PAYMENT_PROVIDER=mock docker compose up -d api worker` |
| Start completely fresh | `docker compose down -v` (deletes the local database, photos and search index), then sections 2–3 |

## 8. Where things are

```
FS-01/
├── backend/                 Express API + background worker (TypeScript)
│   ├── prisma/              schema.prisma (17 tables) and migrations/
│   ├── seed/                demo catalogue snapshot (catalog.json)
│   ├── src/
│   │   ├── index.ts         API entry: connects services, serves HTTP, shuts down cleanly
│   │   ├── worker.ts        worker entry: BullMQ queues (search, invoices, refunds/payouts, reservations)
│   │   ├── app.ts           builds the Express app from its dependencies (tests pass fakes)
│   │   ├── config/env.ts    every setting, checked with Zod at start-up
│   │   ├── lib/             db (Prisma), transactions, Redis, Elasticsearch, S3, cache, rate limits, logger
│   │   ├── middleware/      auth, CSRF, validation, errors
│   │   ├── modules/<area>/  one folder per feature: routes, services, pure *-rules.ts, row mappers
│   │   │                    (auth, users, account, vendors, catalog, uploads, search, cart, orders,
│   │   │                     payments, coupons, reviews, invoices, analytics)
│   │   └── scripts/         seed-users, seed-catalog, seed-orders, reindex
│   └── tests/               unit tests; tests/integration/ uses the real services
├── frontend/                React 19 + Vite + Tailwind
│   ├── src/api/             data hooks (TanStack Query) and the fetch client
│   ├── src/pages/           shop pages; pages/vendor and pages/admin for those roles
│   ├── src/components/      shared UI
│   ├── nginx.conf           serves the built app in Docker and forwards /api
│   └── vercel.json          the live frontend's /api rewrite
├── deploy/                  live server: Caddyfile, setup, auto-deploy, nightly reset, timers, env example
├── perf/                    k6 load test and its results
├── scripts/smoke-test.sh    end-to-end check of a running stack
├── docker-compose.yml       the local stack
├── docker-compose.prod.yml  the live server's stack
└── docs/                    this documentation
```
