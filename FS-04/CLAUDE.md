# CLAUDE.md — FS-04 TaskFlow

Multi-tenant, Jira-style project management SaaS (capstone FS-04). Every company gets an isolated workspace with projects, drag-and-drop Kanban boards, sprints, workflows, an audit log, webhooks, background jobs and Stripe billing.
Status: **v2.0.0** rebuilt the backend in Node.js/Express/TypeScript/Prisma and the frontend in TypeScript (the brief's required tools changed on 17 Nov 2026), keeping the v1 API contract exactly. v1.0.1 (Django) stays tagged. Live at **https://taskflow-fs04.onrender.com** (free, always on, auto-deployed by CI; see "Live site"). Full docs: [`docs/README.md`](docs/README.md).

## Working rules

- **Explain first, then change.** Propose changes for review; never commit, push or tag without the user's explicit approval (each one separately).
- **FS-04 stands alone in a shared repo** (full rules: "Two projects in one repo" in the root `CLAUDE.md`). From FS-04 work, edit only `FS-04/`, FS-04's row in the root `README.md` and `.github/workflows/fs04-ci.yml`; never `FS-01/`, FS-01's row or `fs01-ci.yml`. Shared parts of the root README and `CLAUDE.md` change only when the user asks. Stage by path (`git add FS-04 .github/workflows/fs04-ci.yml`), never `git add -A`, because FS-01 work may be uncommitted in the same folder.
- **Before every push:** `git pull --no-rebase origin main` (FS-01 may have pushed), then push. If local `main` holds FS-01 commits that aren't on GitHub, ask the user before pushing: the push would publish them too.
- **Plain `v*` tags belong to FS-04**; FS-01 uses `fs01-v*` (never create one from here). `fs04-ci.yml` turns any `v*` tag into a "TaskFlow" GitHub Release. Never link to `releases/latest`; name the FS-04 tag (`releases/download/v2.0.0/…`).
- **Required stack** (the brief): React, TypeScript, Node.js, Express, PostgreSQL, Prisma, Vitest, Docker. Don't add another backend language or test runner.
- **The API contract is fixed**: URLs with trailing slashes, integer ids, snake_case fields, `{count,next,previous,results}` pages, `{detail}` / `{field: [msgs]}` errors. Change it only together with the frontend, `openapi.yaml` and the tests.
- **Docs:** one numbered file per topic in `docs/` with an index README and previous / index / next links on every page (never one long file). Update the affected docs and the test counts with every change. After an API change, edit `backend/openapi.yaml` and run `npm run openapi` (copies it to `docs/openapi.yaml`); `tests/openapi.test.ts` checks it against the routes.
- **Every fix gets a regression test.** Commit messages use `type(scope): summary` (`fix(board): …`, `ci: …`, `docs(fs04): …`).
- **Manual steps for the user are numbered, one action each**, saying where it happens (On your PC / In the browser: Render, Neon, GitHub, UptimeRobot) and what they should see afterwards; point out placeholders with an example value. Never ask them to paste secrets (connection strings, deploy hooks, keys) into the chat.

## Tech stack

| Layer | Technology |
|---|---|
| API | Node.js 24, Express 5, TypeScript 6 (strict, NodeNext ESM), Zod 4, `jose` (JWT HS256), bcryptjs, multer, pino, helmet, express-rate-limit |
| Database | PostgreSQL 16 via Prisma 7 (`prisma-client` generator → `src/generated/prisma`, git-ignored; `@prisma/adapter-pg`). Shared schema with `workspaceId` on every tenant row (`useWorkspace` middleware, `X-Workspace` header, 404 for non-members) |
| Background jobs | BullMQ 5 + Redis 7: one worker runs the jobs and the schedule (`src/jobs/registry.ts`) |
| Billing | Stripe Node SDK; `STRIPE_MOCK=true` (default) uses Stripe's official `stripe-mock` v0.206.0 with signed webhooks |
| Frontend | React 18, TypeScript (strict), Vite 7, React Router 6 (v7 flags on), @hello-pangea/dnd, Vitest 4 + Testing Library, ESLint 9 |
| Infra | Docker Compose (6 services: db, redis, stripe-mock, backend, worker, frontend/nginx), GitHub Actions, GHCR images (amd64 + arm64) |
| Tests | Vitest + Supertest on a real PostgreSQL (`<db>_test`, created and migrated by `tests/global-setup.ts`); coverage gate 90% lines |
| Live demo | Render free web service running `deploy/render/Dockerfile` (all processes in one container under supervisord, the worker inside the API process, 512 MB / 0.1 CPU) + Neon free Postgres + UptimeRobot keep-alive; `DEMO_MODE=true` locks the demo logins and resets the demo nightly |

Roles per workspace: viewer < member < admin < owner. Demo logins (from the seed, password `demo12345`): `owner@acme.test`, `admin1@`, `member2@`, `member3@`, `viewer4@acme.test`, and `owner@globex.test`.

## Layout

```
backend/   prisma/ (schema + migrations) · src/{app,index,worker,config}.ts · src/lib · src/jobs · src/modules/{auth,tenancy,tracker,audit,integrations,billing,demo} · src/scripts · openapi.yaml · tests/
frontend/  src/{api,boardLogic,types}.ts · src/{auth,workspace,App}.tsx · components/ · pages/ · test/
scripts/   smoke-test.sh (full user flow, or --read-only for the live site)
deploy/render/  all-in-one live image: Dockerfile, supervisord.conf, nginx.conf.template, start.sh
docs/      01–14 topic docs, specs/, guides/, assets/, openapi.yaml (copy of backend/openapi.yaml)
docker-compose.yml          build from source
docker-compose.release.yml  run a published release (no build)
```

## Commands

Run from `FS-04/` unless noted. Shell examples are Git Bash; PowerShell equivalents are in the README.

**Full stack (Docker)**

```bash
cp .env.example .env                       # once; FRONTEND_PORT=3001 if 3000 is taken
docker compose up -d --build --wait        # app http://localhost:3000, API docs http://localhost:8000/api/docs/
docker compose exec backend node dist/scripts/seed-demo.js           # demo data (refuses unless DEBUG=true, or --force)
docker compose exec backend node dist/scripts/seed-demo.js --reset   # wipe and re-seed the demo tenants
bash scripts/smoke-test.sh http://localhost:3000                     # same checks CI runs (signs up one throwaway user)
```

**Backend** (from `backend/`, with `docker compose up -d db redis stripe-mock` running; tests use their own database `taskflow_test`)

```bash
npm install                      # also runs prisma generate
npm run lint && npm run typecheck
npm test                         # 197 tests, ~2.5 min (the demo/seed suite is the slow one)
npm run test:coverage            # same, fails below 90% lines (currently ~96%)
npx vitest run tests/issues.test.ts -t "move"     # one suite / test
npm run dev                      # API with reload; npm run dev:worker for jobs (or JOBS_INLINE=true)
npm run db:migrate -- --name <change>             # after editing prisma/schema.prisma; commit the migration
npm run openapi                  # copy backend/openapi.yaml to docs/
```

**Frontend** (from `frontend/`)

```bash
npm ci
npm run lint            # ESLint + tsc (strict app config) + tsc -p tsconfig.test.json (tests)
npx vitest run          # 62 tests
npm run build
npm run dev             # http://localhost:5173, proxies /api to :8000
```

**Live-site image** (from `FS-04/`; mirrors Render's free limits)

```bash
docker build -f deploy/render/Dockerfile -t taskflow-live .
docker run --rm -p 3005:10000 --memory 512m --cpus 0.1 -e DATABASE_URL=postgresql://... -e SECRET_KEY=... taskflow-live
bash scripts/smoke-test.sh --read-only http://localhost:3005   # read-only: signs in, creates nothing (use on the live site)
```

**Run a published release** (no build; settings such as `TASKFLOW_TAG` and `FRONTEND_PORT` go in `.env`)

```bash
docker compose -f docker-compose.release.yml up -d --wait
```

## CI/CD (`../.github/workflows/fs04-ci.yml`)

Triggered by pushes to `main`, pull requests touching `FS-04/**`, and `v*` tags:
backend (Node 24: ESLint, `tsc`, Vitest with coverage against Postgres/Redis/stripe-mock services) + frontend (ESLint + `tsc`, Vitest, build) → smoke (build + `docker compose up` + `scripts/smoke-test.sh` full flow) → publish (amd64/arm64 images to GHCR: `latest`, `sha-<commit>`, semver on tags) → verify-release (pull the published images, run `docker-compose.release.yml`, smoke-test; records a `release` deployment) → release (GitHub Release, `v*` tags only) → deploy-server (main only: Render deploy hook with `ref=<commit>`, wait until `/api/health/` reports the commit, then `smoke-test.sh --read-only` on the live site; records a `production` deployment).

Check runs without the `gh` CLI (not installed) via the public API:

```bash
curl -s "https://api.github.com/repos/Adarsh619/Rout_Adarsh_Pradhan_Capstone_Projects/actions/workflows/fs04-ci.yml/runs?per_page=3"
```

## Live site

| Piece | Setup |
|---|---|
| **Render** web service `taskflow-fs04` (Singapore, Free) | Root dir `FS-04`, Dockerfile `./deploy/render/Dockerfile`, health check `/healthz`, **auto-deploy off** (only CI deploys). Env vars: `DATABASE_URL` (Neon), `DJANGO_SECRET_KEY` (still read under its v1 name; `SECRET_KEY` also works); everything else is an image default (`DEMO_MODE=true`, `DEBUG=false`, `EMBEDDED_WORKER=true`, `TRUSTED_PROXY_COUNT=4`, ...) |
| **Neon** project `taskflow` (Singapore, Free) | Direct connection string (pooling off), `sslmode=require`. v2 uses database `taskflow_node`; the v1 database is kept for rollback |
| **UptimeRobot** monitor "TaskFlow live" | `/api/health/` every 5 min: keeps Render awake (~744 of 750 free hours), emails on downtime |
| **GitHub** repo settings | Secret `BACKEND_DEPLOY_HOOK`; variables `LIVE_URL=https://taskflow-fs04.onrender.com`, `DEPLOY_ENABLED=true` |

Check the live site from here:

```bash
curl -s https://taskflow-fs04.onrender.com/api/health/          # {"status": "ok", "version": "<deployed commit>"}
bash scripts/smoke-test.sh --read-only https://taskflow-fs04.onrender.com
```

Never run the full smoke test or create test data on the live site unless the user agrees; visitor data is purged after 7 days and the demo resets nightly (21:00 UTC = 02:30 IST).

**Operating it (the user's routine):**
- It runs unattended: UptimeRobot emails on downtime, GitHub emails on failed pipelines. The user checks the site about once a week and before demos; Neon usage (compute < 100 h/month, storage < 1 GB) on the same check.
- UptimeRobot (account time zone **IST**) uses **HEAD** (GET is paid-only; HEAD counts as traffic for Render) with a 30 s timeout, from North America. A "down" then "up" email pair is **expected on every deploy or Render setting change**: the container needs ~2 min to start on 0.1 CPU.
- Investigate only if an alert has no deploy or restart around it, or lasts over ~5 min: compare the alert time (IST) with Render → **Events** (also IST), then Render → **Logs**.
- A pipeline failure in `docker/setup-buildx-action` (or a cancelled sibling publish job) is a GitHub-side hiccup, not our code: the user clicks **Re-run failed jobs**; nothing is deployed when publishing fails.
- Keep it running until the capstone submission has been reviewed, not only until the 20 Nov 2026 deadline.

## Gotchas

- **Lock files must be generated on Linux** (`docker run --rm -v "$PWD:/src" node:24-alpine sh -c "cp /src/package.json /tmp && cd /tmp && npm install --package-lock-only --ignore-scripts && cp package-lock.json /src/"`): a Windows-made lock misses optional packages Linux needs, and `npm ci` fails in the image build.
- Prisma can't express partial unique indexes, the sprint date check or the audit-log trigger; they are raw SQL at the end of `prisma/migrations/20261117000000_init/migration.sql`. Never edit an applied migration; add a new one.
- The audit log is append-only **in the database** (trigger): test code can't `deleteMany()` audit rows either; the test setup uses `TRUNCATE`.
- Prisma drops `undefined` filter values (`{ field: undefined }` matches everything); build `where` objects carefully.
- Tests: `JOBS_INLINE=true`, emails go to `outbox`, webhook HTTP and DNS are stubbed (`http.post`, `dns.resolve`); `testing.held = []` holds queued jobs to run by hand; `fakes.client` / `handlers` in `billing/stripe.ts` stand in for Stripe in live mode.
- The board's SQL budget (11 statements) is asserted in `tests/demo.test.ts`; `SHOW_SQL=1` prints the statements.
- Docker Desktop sometimes stops mid-session; if tests hang on Postgres, check `docker info` first. The v1 stack (project `fs-04`) and a v2 stack started from the worktree share the compose project name unless you pass `-p`.
- The live container takes ~2 min to start on 0.1 CPU; Render's health check uses `/healthz` (answered by nginx), CI waits on `/api/health/` `version` = the deployed commit.
- `TRUSTED_PROXY_COUNT=4` was measured on Render (Cloudflare edge → Render LB → Render proxy → nginx); Express applies it via `trust proxy`. The container prefers IPv4 (`/etc/gai.conf`) because Render has no IPv6 route.
- Render's port scan triggers a harmless Redis "Possible SECURITY ATTACK" log line; Redis listens on 127.0.0.1 only.
