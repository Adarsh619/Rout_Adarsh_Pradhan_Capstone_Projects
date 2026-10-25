# Technical Requirements Document (TRD) · TaskFlow

[← PRD](01-prd.md) · [Index](../README.md) · [Next: App flow →](03-app-flow.md)

This document defines **how** the product in the [PRD](01-prd.md) is built: stack, architecture, interfaces and quality targets.

## 1. Technology stack

| Layer | Technology (version) | Why |
|---|---|---|
| Language (backend) | Python 3.12 | Required by the brief (Django) |
| Web framework | Django 5.2 LTS + Django REST Framework 3.17 | Mature ORM, admin, auth; DRF viewsets, permissions, filtering |
| Auth | djangorestframework-simplejwt 5.5 | Stateless JWT for a SPA |
| API docs | drf-spectacular 0.30 | OpenAPI 3 schema + Swagger UI |
| Database | PostgreSQL 16 | Required; row locks, JSONB, strong constraints |
| Queue / jobs | Celery 5.6 + Redis 7 | Required; retries, scheduling (beat) |
| Billing | stripe-python 16 + Stripe Billing / `stripe-mock` | Required; official SDK; mock for invite-only regions |
| Frontend | React 18, Vite 5, React Router 6 | Required; fast dev build |
| Drag-and-drop | @hello-pangea/dnd 17 | Accessible (keyboard) Kanban DnD |
| Serving | gunicorn (API), nginx (SPA + proxy), WhiteNoise (admin static) | Production-style serving in containers |
| Containers | Docker, Docker Compose | Required; one-command stack |
| CI/CD | GitHub Actions, GitHub Container Registry | Required; free for this repo |
| Testing | pytest + pytest-django + coverage, Vitest + Testing Library, Playwright (manual E2E) | Fast unit/integration tests on real PostgreSQL |
| Code quality | ruff (Python), ESLint (JS) | Enforced in CI |

## 2. Architecture

Detailed in [03 · System architecture](../03-architecture.md). In short: React SPA → nginx → Django REST API (one instance for all tenants) → PostgreSQL; Redis → Celery worker / beat for background work; Stripe (or stripe-mock) for billing.

## 3. Multi-tenancy

| Requirement | Implementation |
|---|---|
| TR-T1 Shared schema | Abstract `TenantModel` adds an indexed `workspace_id` FK to every tenant table |
| TR-T2 Tenant resolution | `X-Workspace: <slug>` header → membership lookup in `TenantScopedMixin.initial()` |
| TR-T3 Scoped queries | `get_queryset()` filters by `request.workspace`; `perform_create()` stamps it |
| TR-T4 Cross-tenant references | `TenantPKField` / `MemberPKField` restrict FK choices to the current workspace |
| TR-T5 Non-disclosure | Non-members get 404, not 403 |
| TR-T6 Verification | Isolation tests in `tests/test_auth_and_tenancy.py` |

## 4. API standards

| Topic | Standard |
|---|---|
| Style | REST, JSON, plural resource names under `/api/` |
| Auth | `Authorization: Bearer <access JWT>`; access 60 min, refresh 7 days |
| Tenant | `X-Workspace` header on all tenant-scoped endpoints |
| Pagination | Limit/offset, default page size 100 |
| Filtering | `django-filter` query params; `?search=`; `?ordering=` |
| Errors | DRF error bodies; 400 validation, 401 auth, 402 plan limit, 403 role, 404 not found / other tenant |
| Rate limiting | 2,000 requests/hour per user (`API_RATE_LIMIT`) |
| Documentation | OpenAPI 3 at `/api/schema/`, Swagger UI at `/api/docs/`, committed `docs/openapi.yaml` |
| Custom actions | Verb sub-routes: `/issues/{id}/move/`, `/sprints/{id}/start/`, `/webhooks/{id}/ping/` |

Full reference: [06 · API](../06-api.md).

## 5. Data

| Requirement | Implementation |
|---|---|
| Schema | 19 models, see [Backend schema](06-backend-schema.md) |
| Integrity | Unique constraints (project key per workspace, issue number per project, membership, transitions); PROTECT on statuses and workflows in use |
| Concurrency | `SELECT … FOR UPDATE` on project counter and on the destination column during moves |
| Migrations | Django migrations committed; CI fails on missing migrations (`makemigrations --check`) |
| Seed data | `manage.py seed_demo` (Faker, deterministic seed 42) |

## 6. Background processing

| Requirement | Implementation |
|---|---|
| Post-commit dispatch | `transaction.on_commit` for webhooks and emails |
| Retries | Webhook delivery: 5 attempts total, backoff 30/60/120/240 s |
| Schedules | Celery beat: reminders daily 07:00 UTC; reports Mondays 06:00 UTC |
| Testability | `CELERY_TASK_ALWAYS_EAGER=true` runs tasks inline in tests/dev |

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
| Unit / integration (backend) | pytest on PostgreSQL | Models, permissions, API endpoints, tasks, billing |
| Integration (Stripe) | pytest + `stripe-mock` service | Real SDK calls against Stripe's mock |
| Unit (frontend) | Vitest + Testing Library | Board logic, components, API helpers |
| End-to-end | Playwright (manual run) | Login, drag-and-drop, billing flow |
| Performance guard | pytest query counting | Board endpoint query budget |

Results: [12 · Testing](../12-testing.md).

## 12. CI/CD

Lint + tests for backend and frontend on every push/PR touching `FS-04/`; on `main`, build and push Docker images to GHCR, then call deploy hooks if configured. See [11 · DevOps](../11-devops.md).
