# ShopSphere — Multi-Vendor E-Commerce Marketplace

[![FS-01 CI](https://github.com/Adarsh619/Rout_Adarsh_Pradhan_Capstone_Projects/actions/workflows/fs01-ci.yml/badge.svg?branch=main)](https://github.com/Adarsh619/Rout_Adarsh_Pradhan_Capstone_Projects/actions/workflows/fs01-ci.yml)

An Amazon-style marketplace where **many vendors sell**, **customers buy from several of them in one checkout**, and the platform
**splits each payment** between the vendors and keeps a **commission** (Razorpay test mode for payments; vendor payouts simulated).

| Layer | Tech |
|---|---|
| Frontend | React 19 · Vite · React Router · TanStack Query · Tailwind CSS |
| API + worker | Node.js 24 · Express 5 · TypeScript · Zod · BullMQ |
| Data | MongoDB 7.0 (replica set, transactions) · Redis 7.4 · Elasticsearch 8.19 |
| Files | AWS S3 (Adobe S3Mock locally) |
| Payments | Razorpay test mode (UPI, cards, webhooks, refunds) + own split-and-escrow ledger; built-in mock needs no account |
| Infra | Docker Compose · nginx · GitHub Actions |

**Status:** Day 2 of 10. Specs, architecture, schema and API list are done; sign-in with JWT and role-based access works end to end (customer, vendor, admin). Progress is tracked in the [10-day build tracker](docs/guides/DAY_PLAN.md).

![Architecture](docs/assets/architecture.png)

## Quick start (Docker)

Prerequisite: Docker Desktop (give it at least 4 GB of memory; Elasticsearch needs it).

```bash
cp .env.example .env            # Windows PowerShell: copy .env.example .env
docker compose up --build
```

| URL | What |
|---|---|
| http://localhost:3000 | Web app (shows the status of every service) |
| http://localhost:3000/api/v1/health | API health through nginx |
| http://localhost:4000/api/v1/health | API health, direct |

Create the demo accounts (one per role; the password is `DEMO_PASSWORD` in `.env`):

```bash
docker compose exec api node dist/scripts/seed-users.js
```

| Email | Role | Lands on |
|---|---|---|
| `customer@shopsphere.test` | Customer | /account |
| `vendor@shopsphere.test` | Vendor | /vendor |
| `admin@shopsphere.test` | Admin | /admin |

Port 3000 taken? Set `FRONTEND_PORT=3001` in `.env`. MongoDB, Redis, Elasticsearch, S3Mock and the API publish their ports on `127.0.0.1` only.

## Developing without rebuilding images

Keep the backing services in Docker and run the code on your PC with hot reload:

```bash
docker compose up -d mongo redis elasticsearch s3
cd backend && npm install && npm run dev        # API on :4000 (another terminal: npm run dev:worker)
cd frontend && npm install && npm run dev       # app on :5173, /api is proxied to :4000
```

The backend's defaults already point at these local services.

## Tests

```bash
cd backend && npm run lint && npm test           # unit tests, no services needed
cd backend && npm run test:integration           # needs the Docker services above
cd frontend && npm run lint && npm test
bash scripts/smoke-test.sh http://localhost:3000 # whole stack, through nginx
```

CI ([`.github/workflows/fs01-ci.yml`](../.github/workflows/fs01-ci.yml)) runs all of these on every push that touches `FS-01/`.

## Documentation

Everything is in [`docs/`](docs/README.md): overview, features and roles, architecture, design decisions, data model, PRD, app flow, database schema and API list. More topics are added as each part is built.
