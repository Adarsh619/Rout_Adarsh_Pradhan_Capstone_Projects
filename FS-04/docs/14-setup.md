# 14 · Setup and repository layout

[← Challenges and next steps](13-challenges-and-next-steps.md) · [Index](README.md)

## Run with Docker (recommended)

Prerequisite: Docker Desktop (on Windows, with WSL 2).

```powershell
copy .env.example .env
docker compose up --build
docker compose exec backend python manage.py seed_demo
```

| URL | What |
|---|---|
| http://localhost:3000 | The app. Sign in as `owner@acme.test` / `demo12345` |
| http://localhost:8000/api/docs/ | Swagger API docs |
| http://localhost:8000/admin/ | Django admin (`docker compose exec backend python manage.py createsuperuser`) |

Other demo users (same password): `admin1@acme.test`, `member2@acme.test`, `viewer4@acme.test`, and `owner@globex.test` in a second tenant.

What the demo data contains, for each of the two companies (Acme Corp, Globex Inc):

| Data | Detail |
|---|---|
| People | Owner, one admin, two members and one viewer. Viewers never report, comment on or get assigned issues, as in the real app |
| Projects | WEB (Kanban board) and API (Scrum board), 60 issues each (`--issues N` to change) with comments, due dates and story points |
| Sprints | Sprint 0 (closed, with finished work), Sprint 1 (active), Sprint 2 (planned) per project |
| History | A full audit trail: members added, projects and sprints created, every issue created and walked through the workflow, every comment. A few notifications per person (two unread). One weekly report |
| Plan | Free, so the 2-project and 5-member limits are already reached: good for demonstrating the upgrade |

`seed_demo --reset` deletes and recreates both companies. The command refuses to run with `DJANGO_DEBUG=false` (the demo password is public) unless you pass `--force`.

Run the backend tests inside Docker:

```powershell
docker compose exec backend sh -c "pip install -q -r requirements-dev.txt && pytest"
```

## Run without Docker

Needs Python 3.12+, Node 20+, PostgreSQL and Redis (or `docker compose up db redis stripe-mock`).

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
python manage.py migrate
python manage.py seed_demo
python manage.py runserver

cd ..\frontend
npm install
npm run dev        # http://localhost:5173
```

## Environment variables (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DJANGO_SECRET_KEY`, `DJANGO_DEBUG`, `DJANGO_ALLOWED_HOSTS` | dev values | Django security settings |
| `DATABASE_URL`, `REDIS_URL` | localhost | Overridden by Docker Compose |
| `CELERY_TASK_ALWAYS_EAGER` | `false` | `true` runs jobs inline without a worker |
| `STRIPE_MOCK` | `true` | Billing mode, see [09 · Billing](09-billing.md) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_BUSINESS` | empty | Only for real Stripe test mode |
| `TRUSTED_PROXY_COUNT` | `0` (Docker Compose sets `1`) | Proxies in front of Django; picks the real client IP for the audit log and rate limits, see [10 · Security](10-security.md) |
| `API_RATE_LIMIT`, `AUTH_RATE_LIMIT` | `2000/hour`, `10/minute` | Rate limits for the whole API and for register / login / password change |
| `WEBHOOK_ALLOW_PRIVATE_URLS` | `false` | `true` lets webhooks target internal addresses, only for testing against a receiver on your own machine |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30` | How long webhook delivery logs are kept |
| `FRONTEND_PORT` | `3000` | Host port for the app; change it if 3000 is in use |
| `TASKFLOW_TAG` | `latest` | Only for `docker-compose.release.yml`: which published version to run (`latest`, `1.0.0`, `sha-<commit>`) |
| `WEB_CONCURRENCY` | `3` | Gunicorn web worker processes |
| `VITE_DEMO_HINT` | `true` | Shows the demo login on the sign-in page; `false` hides it. Read when the frontend is built, so rebuild the `frontend` image after changing it |

## Repository layout

```
FS-04/
├── backend/
│   ├── config/            settings, urls, celery app
│   ├── apps/
│   │   ├── accounts/      email-login User, register/me
│   │   ├── tenancy/       Workspace, Membership, roles, tenant mixin
│   │   ├── tracker/       workflows, projects, boards, sprints, issues, comments, attachments
│   │   ├── audit/         AuditLog + record()
│   │   ├── integrations/  webhooks, notifications, reports, Celery tasks
│   │   └── billing/       plans, limits, Stripe service, mock mode
│   └── tests/             pytest suites
├── frontend/src/
│   ├── components/        Layout, IssueModal, IssueCard, Notifications, Modal
│   ├── pages/             Board, Sprints, Projects, Members, Workflows, Webhooks, AuditLog, Reports, Billing, MockCheckout
│   └── test/              Vitest tests
├── docs/                  this documentation
├── docker-compose.yml
└── .env.example
```
