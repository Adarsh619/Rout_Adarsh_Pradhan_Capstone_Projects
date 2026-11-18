# 14 · Setup and repository layout

[← Challenges and next steps](13-challenges-and-next-steps.md) · [Index](README.md)

## Run with Docker (recommended)

Prerequisite: Docker Desktop (on Windows, with WSL 2).

```powershell
copy .env.example .env
docker compose up --build
docker compose exec backend node dist/scripts/seed-demo.js
```

| URL | What |
|---|---|
| http://localhost:3000 | The app. Sign in as `owner@acme.test` / `demo12345` |
| http://localhost:8000/api/docs/ | Swagger API docs |

Other demo users (same password): `admin1@acme.test`, `member2@acme.test`, `viewer4@acme.test`, and `owner@globex.test` in a second tenant.

What the demo data contains, for each of the two companies (Acme Corp, Globex Inc). It is generated with Faker (`@faker-js/faker`), with a fixed seed so every run gives the same data:

| Data | Detail |
|---|---|
| People | Owner, one admin, two members and one viewer. Viewers never report, comment on or get assigned issues, as in the real app |
| Projects | WEB (Kanban board) and API (Scrum board), 60 issues each (`--issues N` to change) with comments, due dates and story points |
| Sprints | Sprint 0 (closed, with finished work), Sprint 1 (active), Sprint 2 (planned) per project |
| History | A full audit trail: members added, projects and sprints created, every issue created and walked through the workflow, every comment. A few notifications per person (two unread). One weekly report |
| Plan | Free, so the 2-project and 5-member limits are already reached: good for demonstrating the upgrade |

`seed-demo.js --reset` deletes and recreates both companies. The seed refuses to run with `DEBUG=false` (the demo password is public) unless you pass `--force`.

Run the backend tests against the Docker databases (from `backend/`, with Node.js 24 on your machine):

```powershell
docker compose up -d db redis stripe-mock
npm install
npm test
```

## Run without Docker

Needs Node.js 24+, plus PostgreSQL, Redis and stripe-mock (or `docker compose up -d db redis stripe-mock`).

```powershell
cd backend
npm install                  # also generates the typed Prisma client
npx prisma migrate deploy
npm run seed
npm run dev                  # API on :8000
npm run dev:worker           # background jobs (second terminal), or set JOBS_INLINE=true instead

cd ..\frontend
npm install
npm run dev                  # http://localhost:5173
```

After changing `prisma/schema.prisma`, create a migration with `npm run db:migrate -- --name <change>` and commit it.

## Live demo deployment

The public site runs the all-in-one image from `deploy/render/` on a free Render web service, with a free Neon Postgres database; the full setup is in [DevOps · Live deployment](11-devops.md#live-deployment-free-always-on). To try that image locally with Render's limits:

```bash
docker build -f deploy/render/Dockerfile -t taskflow-live .
docker run --rm -p 3005:10000 --memory 512m --cpus 0.1 \
  -e DATABASE_URL=postgresql://user:pass@host:5432/db -e SECRET_KEY=change-me taskflow-live
bash scripts/smoke-test.sh --read-only http://localhost:3005
```

## Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SECRET_KEY` | dev value | Signs login tokens. Required when `DEBUG=false` (the v1 name `DJANGO_SECRET_KEY` is still read) |
| `DEBUG` | `true` outside production | Development mode; the demo seed only runs with `true` unless forced |
| `DATABASE_URL`, `REDIS_URL` | localhost | Overridden by Docker Compose |
| `JOBS_INLINE` | `false` | `true` runs background jobs inside the API process (no worker or Redis needed) |
| `EMBEDDED_WORKER` | `false` | `true` runs the BullMQ worker inside the API process (the live site's single container) |
| `STRIPE_MOCK` | `true` | Billing mode, see [09 · Billing](09-billing.md) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | empty | Only for real Stripe test mode |
| `TRUSTED_PROXY_COUNT` | `0` (Docker Compose sets `1`) | Proxies in front of the API; picks the real client IP for the audit log and rate limits, see [10 · Security](10-security.md) |
| `API_RATE_LIMIT`, `AUTH_RATE_LIMIT` | `2000/hour`, `10/minute` | Rate limits for the whole API and for register / login / password change |
| `CORS_ALLOWED_ORIGINS`, `FRONTEND_URL` | localhost | Browser origins allowed to call the API; where Stripe sends people back after checkout |
| `EMAIL_TRANSPORT` | `console` | `console` prints emails to the worker log; an `smtp://` URL sends them |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | `false` | `true` lets webhooks target internal addresses, only for testing against a receiver on your own machine |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | How long webhook delivery logs are kept |
| `MAX_ATTACHMENT_SIZE` | 10 MB | Largest attachment upload |
| `FRONTEND_PORT` | `3000` | Host port for the app; change it if 3000 is in use |
| `DEMO_MODE` | `false` | `true` on the public demo: locks the demo logins, nightly reset, visitor clean-up |
| `DEMO_VISITOR_RETENTION_DAYS` | `7` | Demo mode: days before visitors' own workspaces and accounts are removed |
| `TASKFLOW_TAG` | `latest` | Only for `docker-compose.release.yml`: which published version to run (`latest`, `2.0.0`, `sha-<commit>`). Set it in `.env`, which works on every OS |
| `VITE_DEMO_HINT` | `true` | Shows the demo login on the sign-in page; `false` hides it. Read when the frontend is built, so rebuild the `frontend` image after changing it |

## Repository layout

```
FS-04/
├── backend/
│   ├── prisma/            schema.prisma + migrations
│   ├── src/
│   │   ├── app.ts         the Express app
│   │   ├── index.ts       API process      worker.ts  background worker process
│   │   ├── config.ts      settings from the environment
│   │   ├── lib/           database, errors, validation, pagination, email
│   │   ├── jobs/          BullMQ queue, job registry, schedule
│   │   ├── modules/       auth, tenancy, tracker, audit, integrations, billing, demo
│   │   └── scripts/       seed-demo, write-openapi
│   ├── openapi.yaml       the API description
│   └── tests/             Vitest + Supertest suites
├── frontend/src/
│   ├── components/        Layout, IssueModal, IssueCard, Notifications, Modal
│   ├── pages/             Board, Sprints, Projects, Members, Workflows, Webhooks, AuditLog, Reports, Billing, MockCheckout
│   ├── types.ts           the API's data shapes
│   └── test/              Vitest tests
├── deploy/render/         the all-in-one live-site image
├── scripts/smoke-test.sh  whole-stack check (CI and live site)
├── docs/                  this documentation
├── docker-compose.yml     build from source
├── docker-compose.release.yml   run a published release
└── .env.example
```
