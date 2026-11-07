# CLAUDE.md — FS-04 TaskFlow

Multi-tenant, Jira-style project management SaaS (capstone FS-04). Every company gets an isolated workspace with projects, drag-and-drop Kanban boards, sprints, workflows, an audit log, webhooks, background jobs and Stripe billing.
Status: build complete, released as **v1.0.1**. Full docs: [`docs/README.md`](docs/README.md).

## Working rules

- **Explain first, then change.** Propose changes for review; never commit, push or tag without the user's explicit approval (each one separately).
- **FS-04 stands alone.** This Git repo also holds FS-01: never edit `FS-01/` or `.github/workflows/fs01-ci.yml` from FS-04 work, and stage only FS-04 files (`git add FS-04 .github/workflows/fs04-ci.yml`), because other work may be uncommitted in the same folder.
- **Plain `v*` tags belong to FS-04.** `fs04-ci.yml` turns any `v*` tag into a "TaskFlow" GitHub Release. Never link to `releases/latest`; name the FS-04 tag (`releases/download/v1.0.1/…`).
- **Docs:** one numbered file per topic in `docs/` with an index README and previous / index / next links on every page (never one long file). Update the affected docs and the test counts with every change; regenerate `docs/openapi.yaml` when the API changes.
- **Every fix gets a regression test.** Commit messages use `type(scope): summary` (`fix(board): …`, `ci: …`, `docs(fs04): …`).

## Tech stack

| Layer | Technology |
|---|---|
| API | Python 3.12 (Docker/CI; 3.14 also works locally), Django 5.2, Django REST Framework 3.17, SimpleJWT 5.5 (rotating refresh tokens + blacklist), drf-spectacular (OpenAPI), django-filter |
| Database | PostgreSQL 16, shared schema with `workspace_id` on every tenant row (`TenantScopedMixin`, `X-Workspace` header, 404 for non-members) |
| Background jobs | Celery 5.6 + Redis 7 (worker + beat) |
| Billing | Stripe SDK 16; `STRIPE_MOCK=true` (default) uses Stripe's official `stripe-mock` v0.206.0 with signed webhooks |
| Frontend | React 18, Vite 5, React Router 6 (v7 flags on), @hello-pangea/dnd, Vitest 2 + Testing Library, ESLint 9 |
| Infra | Docker Compose (7 services: db, redis, stripe-mock, backend, worker, beat, frontend/nginx), gunicorn, WhiteNoise, GitHub Actions, GHCR images (amd64 + arm64) |
| Tooling | ruff (line length 110), pytest + pytest-django + pytest-cov (coverage gate 90%) |

Roles per workspace: viewer < member < admin < owner. Demo logins (from `seed_demo`, password `demo12345`): `owner@acme.test`, `admin1@`, `member2@`, `member3@`, `viewer4@acme.test`, and `owner@globex.test`.

## Layout

```
backend/   config/ (settings, urls, celery) · apps/{accounts,tenancy,tracker,audit,integrations,billing} · tests/
frontend/  src/{api.js,auth.jsx,workspace.jsx,boardLogic.js} · components/ · pages/ · test/
scripts/   smoke-test.sh
docs/      01–14 topic docs, specs/, guides/, assets/, openapi.yaml
docker-compose.yml          build from source
docker-compose.release.yml  run a published release (no build)
```

## Commands

Run from `FS-04/` unless noted. Shell examples are Git Bash; PowerShell equivalents are in the README.

**Full stack (Docker)**

```bash
cp .env.example .env                       # once; FRONTEND_PORT=3001 if 3000 is taken
docker compose up -d --build --wait        # app http://localhost:3000, API docs http://localhost:8000/api/docs/
docker compose exec backend python manage.py seed_demo           # demo data (refuses unless DJANGO_DEBUG=true, or --force)
docker compose exec backend python manage.py seed_demo --reset   # wipe and re-seed the demo tenants
docker compose up -d --build --wait backend worker beat frontend # rebuild after code changes
bash scripts/smoke-test.sh http://localhost:3000                 # same checks CI runs (signs up one throwaway user)
```

**Backend tests and checks** (from `backend/`, with `docker compose up -d db redis stripe-mock` running; the local venv is `backend/.venv`)

```bash
export DATABASE_URL=postgres://taskflow:taskflow@localhost:5432/taskflow DJANGO_SECRET_KEY=ci-secret STRIPE_MOCK_URL=http://localhost:12111
.venv/Scripts/python -m ruff check .
.venv/Scripts/python manage.py makemigrations --check --dry-run
.venv/Scripts/python -m pytest -p no:cacheprovider -W ignore --cov-fail-under=90     # 176 tests, ~96%, ~45 s
.venv/Scripts/python -m pytest tests/test_issues_api.py --no-cov                     # one suite
.venv/Scripts/python manage.py spectacular --file ../docs/openapi.yaml               # regenerate the API schema (expect 0 errors)
```

**Frontend** (from `frontend/`)

```bash
npm ci
npm run lint
npx vitest run          # 61 tests (npm test does the same)
npm run build
npm run dev             # http://localhost:5173, proxies /api to :8000
```

**Run a published release** (no build; settings such as `TASKFLOW_TAG` and `FRONTEND_PORT` go in `.env`)

```bash
docker compose -f docker-compose.release.yml up -d --wait
```

## CI/CD (`../.github/workflows/fs04-ci.yml`)

Triggered by pushes and PRs touching `FS-04/**` and by `v*` tags:
backend (ruff, migration check, pytest with Postgres/Redis/stripe-mock) + frontend (lint, Vitest, build) → smoke (build + `docker compose up` + `scripts/smoke-test.sh`) → publish (amd64/arm64 images to GHCR: `latest`, `sha-<commit>`, semver on tags) → verify-release (pull the published images, run `docker-compose.release.yml`, smoke-test; records a `release` deployment) → release (GitHub Release, `v*` tags only) → deploy-server (off unless repo variable `DEPLOY_ENABLED=true`).

Check runs without the `gh` CLI (not installed) via the public API:

```bash
curl -s "https://api.github.com/repos/Adarsh619/Rout_Adarsh_Pradhan_Capstone_Projects/actions/workflows/fs04-ci.yml/runs?per_page=3"
```

## Gotchas

- Windows paths are long: use `backend/.venv` (git-ignored), not a fresh virtualenv elsewhere.
- Docker Desktop sometimes stops mid-session; if tests hang on Postgres, check `docker info` first.
- A source-built stack and a release stack both bind the API to `127.0.0.1:8000`; stop one before starting the other.
- Tests use the fast MD5 password hasher and fake DNS for webhooks (autouse fixtures in `backend/tests/conftest.py`); shared helpers `new_issue`, `move`, `new_sprint` and `stripe_live` live there too.
- Pending and optional: "Level B" live server (Oracle Cloud free ARM VM; `deploy-server` job ready, switched off).
