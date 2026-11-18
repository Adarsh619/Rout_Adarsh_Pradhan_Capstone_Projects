# Technical Requirements Document (TRD) · TaskFlow

[← PRD](01-prd.md) · [Index](../README.md) · [Next: App flow →](03-app-flow.md)

This document defines **how** the product in the [PRD](01-prd.md) is built: stack, architecture, interfaces and quality targets.

## 1. Technology stack

| Layer | Technology (version) | Why |
|---|---|---|
| Runtime / language (backend) | Node.js 24, TypeScript 6 (strict) | Required by the brief |
| Web framework | Express 5 | Required; async handlers need no try/catch |
| Validation | Zod 4 | Request bodies and settings checked at the edge, with field-level errors |
| ORM | Prisma 7 (`@prisma/adapter-pg`) | Required; typed client generated from the schema, versioned migrations |
| Auth | `jose` (JWT, HS256), bcryptjs | Stateless JWT for a SPA; refresh tokens recorded for rotation and logout |
| API docs | OpenAPI 3 (`backend/openapi.yaml`), swagger-ui-express | Served at `/api/schema/` and `/api/docs/`; a test checks it against the routes |
| Database | PostgreSQL 16 | Required; row locks, JSONB, partial indexes, triggers |
| Queue / jobs | BullMQ 5 + Redis 7 | Retries with backoff, scheduled jobs (the Node.js counterpart of Celery) |
| Billing | Stripe Node.js SDK + Stripe Billing / `stripe-mock` | Required; official SDK; mock for invite-only regions |
| Frontend | React 18, TypeScript (strict), Vite 7, React Router 6 | Required; fast dev build, typed API data |
| Drag-and-drop | @hello-pangea/dnd 17 | Accessible (keyboard) Kanban DnD |
| Serving | Node.js (API), nginx (SPA + proxy) | Production-style serving in containers |
| Containers | Docker, Docker Compose | Required; one-command stack |
| CI/CD | GitHub Actions, GitHub Container Registry | Required; free for this repo |
| Testing | Vitest + Supertest (API, real PostgreSQL), Vitest + Testing Library (UI), whole-stack smoke test | Required (Vitest); tests on the real database, not mocks |
| Code quality | ESLint + typescript-eslint, `tsc` type-check | Enforced in CI |

## 2. Architecture

Detailed in [03 · System architecture](../03-architecture.md). In short: React SPA → nginx → Node.js API (one instance for all tenants) → PostgreSQL through Prisma; Redis → BullMQ worker for background work and the schedule; Stripe (or stripe-mock) for billing.

## 3. Multi-tenancy

| Requirement | Implementation |
|---|---|
| TR-T1 Shared schema | Every tenant table in `prisma/schema.prisma` has an indexed `workspaceId` FK |
| TR-T2 Tenant resolution | `X-Workspace: <slug>` header → membership lookup in the `useWorkspace` middleware |
| TR-T3 Scoped queries | Every query filters by `workspaceId`; every create sets it |
| TR-T4 Cross-tenant references | `ref()` / `memberRef()` only accept rows and members of the current workspace |
| TR-T5 Non-disclosure | Non-members get 404, not 403 |
| TR-T6 Verification | Isolation tests in `tests/auth.test.ts`; a 404 check for every resource in `tests/rules.test.ts` |

## 4. API standards

| Topic | Standard |
|---|---|
| Style | REST, JSON, plural resource names under `/api/` |
| Auth | `Authorization: Bearer <access JWT>`; access 60 min, refresh 7 days |
| Tenant | `X-Workspace` header on all tenant-scoped endpoints |
| Pagination | Limit/offset, default page size 100 |
| Filtering | Exact-match query params (`?project=`, `?status=`…); `?search=`; `?ordering=` |
| Errors | `{detail}` or `{field: [messages]}` bodies (the v1 shapes); 400 validation, 401 auth, 402 plan limit, 403 role, 404 not found / other tenant, 429 throttled |
| Rate limiting | 2,000 requests/hour per user (`API_RATE_LIMIT`) |
| Documentation | OpenAPI 3 at `/api/schema/`, Swagger UI at `/api/docs/`, committed `docs/openapi.yaml` |
| Custom actions | Verb sub-routes: `/issues/{id}/move/`, `/sprints/{id}/start/`, `/webhooks/{id}/ping/` |

Full reference: [06 · API](../06-api.md).

## 5. Data

| Requirement | Implementation |
|---|---|
| Schema | 20 tables in `prisma/schema.prisma`, see [Backend schema](06-backend-schema.md) |
| Integrity | Unique constraints (project key per workspace, issue number per project, membership, transitions); statuses and workflows in use can't be deleted (`onDelete: Restrict`); partial unique indexes, a check constraint and an append-only trigger in raw SQL |
| Concurrency | `SELECT … FOR UPDATE` on project counter and on the destination column during moves |
| Migrations | Prisma migrations committed (`prisma migrate dev`), applied on start (`prisma migrate deploy`); the tests run on a database built from them |
| Seed data | `seed-demo.ts` (`@faker-js/faker`, deterministic seed 42) |

## 6. Background processing

| Requirement | Implementation |
|---|---|
| Post-commit dispatch | `inTransaction()` after-commit hooks for webhooks and emails |
| Retries | Webhook delivery: 5 attempts total, backoff 30/60/120/240 s |
| Schedules | BullMQ job schedulers: reminders daily 07:00 UTC; reports Mondays 06:00 UTC; delivery-log clean-up 03:30 UTC; demo reset 21:00 UTC |
| Testability | `JOBS_INLINE=true` runs jobs inline in tests and quick development |

Details: [08 · Background jobs](../08-background-jobs.md).

## 7. Billing integration

| Requirement | Implementation |
|---|---|
| Checkout | `stripe.checkout.Session.create(mode="subscription")` with plan price IDs |
| Self-service | `stripe.billing_portal.Session.create` |
| Source of truth | `customer.subscription.*` webhooks update `Subscription` |
| Webhook security | `stripe.Webhook.construct_event` with `STRIPE_WEBHOOK_SECRET` |
| Idempotency | Processed event IDs in `StripeEvent` (unique) |
| Limits | `enforce_limit()` before creating projects, members, issues → 402 |
| Mock mode | `STRIPE_MOCK=true`: SDK → `stripe-mock`; simulated checkout; signed events through the same handler |

Details: [09 · Billing](../09-billing.md).

## 8. Security requirements

See [10 · Security](../10-security.md). Key items: JWT auth, role ladder per action, tenant-checked downloads, HMAC on outgoing webhooks, Stripe signature verification, secrets in `.env` only, non-root containers.

## 9. Performance targets

| Target | Measured |
|---|---|
| Board endpoint ≤ 20 SQL queries regardless of size | 7 queries (60 issues) |
| Board endpoint < 100 ms server time | ~43 ms |
| Frontend bundle < 150 kB gzipped | 96 kB |

## 10. Environments and configuration

| Environment | How it runs | Config |
|---|---|---|
| Local (Docker) | `docker compose up --build` | `.env` (copied from `.env.example`) |
| Local (no Docker) | `runserver` + `npm run dev` + local Postgres/Redis | Same `.env` |
| CI | GitHub Actions service containers | Workflow `env:` |
| Production (optional) | GHCR images + deploy hooks | Platform environment variables |

All configuration comes from environment variables, listed in [14 · Setup](../14-setup.md#environment-variables-env).

## 11. Testing strategy

| Level | Tooling | Scope |
|---|---|---|
| Unit / integration (backend) | Vitest + Supertest on PostgreSQL | Permissions, API endpoints, database rules, jobs, billing |
| Integration (Stripe) | Vitest + `stripe-mock` service | Real SDK calls against Stripe's mock |
| Unit (frontend) | Vitest + Testing Library | Board logic, components, API helpers |
| End-to-end | `scripts/smoke-test.sh` in CI (whole Docker stack); browser checks by hand | Sign-up to billing through nginx |
| Performance guard | Prisma query counting in Vitest | Board endpoint query budget |

Results: [12 · Testing](../12-testing.md).

## 12. CI/CD

Lint + tests for backend and frontend on every push/PR touching `FS-04/`; on `main`, build and push Docker images to GHCR, verify the published images, then deploy the live site. See [11 · DevOps](../11-devops.md).
