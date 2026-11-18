# 11 · DevOps

[← Security](10-security.md) · [Index](README.md) · [Next: Testing and performance →](12-testing.md)

One command, `docker compose up --build`, starts the whole product locally. GitHub Actions tests every change, then deploys it as versioned, verified Docker images that anyone can run with one command.

## Docker Compose services (`docker-compose.yml`)

| Service | Image | Purpose |
|---|---|---|
| `db` | postgres:16-alpine | Database, with a persistent volume (port 5432 on `127.0.0.1` only) |
| `redis` | redis:7-alpine | BullMQ job queue (not published) |
| `backend` | built from `backend/Dockerfile` (node:24-alpine) | The Node.js API (port 8000 on `127.0.0.1`); applies the Prisma migrations (`prisma migrate deploy`) on start |
| `worker` | same image, `node dist/worker.js` | BullMQ worker: runs the jobs and registers the daily and weekly schedule |
| `stripe-mock` | stripe/stripe-mock **v0.206.0** | Stripe's mock API (port 12111 on `127.0.0.1`) |
| `frontend` | built from `frontend/Dockerfile` | nginx serving the React build and proxying `/api` (port `FRONTEND_PORT`, default 3000) |

Start-up order is driven by health checks: the backend waits for PostgreSQL and Redis; the worker and the frontend wait until the backend is **healthy**, which means its migrations have run (otherwise a job could run against tables that don't exist yet). v1 had a separate Celery beat service; BullMQ keeps the schedule in Redis, so the worker does both. Every service has `restart: unless-stopped`, so the stack comes back by itself after Docker Desktop restarts. Uploaded files live in a `media` volume.

Only the app port is reachable from other machines on your network. The database, API and stripe-mock ports are published on `127.0.0.1` for local tools and the test suite, so the demo database with its default password isn't open to the Wi-Fi.

If port 3000 is taken (for example by a dev server), set `FRONTEND_PORT=3001` in `.env`.

### Images

- The backend image is built in two stages: the first installs everything and compiles the TypeScript, the second keeps only production packages, the compiled `dist/`, the Prisma migrations and `openapi.yaml`. `backend/.dockerignore` keeps `node_modules`, builds, coverage and `.env` out of the build context.
- The backend runs as the non-root `node` user. Prisma's migration engine is downloaded at build time (as root), not at start-up.
- The lock files are generated in a Linux container: a lock file written on Windows can miss packages that only Linux installs need, and `npm ci` then fails in the image build.
- stripe-mock is pinned to the same version in Compose and CI, so a new release can't change test results without a commit.

### nginx (`frontend/nginx.conf`)

| Setting | Why |
|---|---|
| `/assets/*` cached for a year (`immutable`) | Vite puts a content hash in each file name, so a changed file has a new name |
| `index.html` sent with `no-cache` | After a deploy, browsers fetch the new page and its new assets instead of the old release |
| gzip for JS, CSS, JSON and SVG | The 338 kB bundle goes over the wire as about 106 kB |
| `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy` | Basic hardening: no MIME sniffing, no framing (clickjacking), no full URLs leaked to other sites |
| `X-Forwarded-For` on `/api` | The audit log and the rate limits see the real client IP |
| `server_tokens off` | Doesn't advertise the nginx version |

## CI/CD pipeline (`.github/workflows/fs04-ci.yml`)

```mermaid
flowchart LR
  T[Push, PR or v* tag<br/>touching FS-04/] --> BE[Backend<br/>ESLint · tsc<br/>Vitest + Postgres, Redis, stripe-mock]
  T --> FE[Frontend<br/>ESLint · tsc · Vitest · Vite build]
  BE --> SM[Smoke test<br/>build + docker compose up<br/>scripts/smoke-test.sh]
  FE --> SM
  SM --> PUB[Publish<br/>amd64 + arm64 images<br/>to GHCR]
  PUB --> VR[Verify release<br/>pull published images<br/>docker-compose.release.yml<br/>same smoke test]
  VR --> REL[GitHub Release<br/>v* tags only]
  VR --> SRV[Deploy live site<br/>main only]
```

| Job | Runs on | Steps |
|---|---|---|
| Backend | Every push / PR | `npm ci` (also generates the Prisma client), ESLint, `tsc` type-check, Vitest + Supertest with PostgreSQL, Redis and stripe-mock service containers (the tests create and migrate their own database); **fails if line coverage drops below 90%** (it's 96% today); uploads JUnit and coverage reports |
| Frontend | Every push / PR | `npm ci`, ESLint + `tsc` (strict for the app, also for the tests), Vitest, production build |
| Smoke test | Every push / PR, after both pass | Builds and starts the real Docker Compose stack from `.env.example` and runs `scripts/smoke-test.sh` through nginx: the React page, `/api/health/`, the API schema and docs, the security headers, then a **full user flow**: sign-up, a project, an issue, a drag to the next column, a comment, its audit entry, a mock Stripe checkout and a report built by the worker. Prints the container logs if anything fails |
| Publish | Pushes to `main` and `v*` tags, after the smoke test | Builds both images for `linux/amd64` and `linux/arm64` and pushes them to GitHub Container Registry with `latest` + `sha-<commit>` tags (and `1.2.3` + `1.2` for a version tag), plus OCI labels linking them to this repository |
| Verify release | After publish | Pulls exactly the images just published (nothing is built), starts them with `docker-compose.release.yml` and runs the same smoke test. Recorded as a deployment to the **`release`** environment on the repository's Deployments page |
| GitHub Release | `v*` tags, after verification | Creates the release with notes, image names and the two files needed to run it |
| Deploy live site | Pushes to `main` when the repository variable `DEPLOY_ENABLED` is `true` | Calls the `BACKEND_DEPLOY_HOOK` secret with this commit, waits until the live site reports it, then runs the read-only smoke test. Recorded as a deployment to **`production`** |

The workflow's token is read-only by default; only the image job gets permission to write packages. Every job has a time limit, so a hung step can't burn CI minutes for hours.

The project lives in the repo's `FS-04/` subfolder, so the workflow sits at the repository root and every path is prefixed with `FS-04/`. It only runs when files under `FS-04/` change.

## Releases and deployment

"Deploy" here means: the tested code is turned into versioned Docker images, published where anyone can pull them, and **proven to work by running the published images** before the release counts as good.

| What | Where to see it |
|---|---|
| Every successful `main` build | Images `fs04-backend` and `fs04-frontend` in GitHub Container Registry (public), tagged `latest` and `sha-<commit>` |
| Proof the published images work | The **Verify published release** job; the repository's **Deployments** page lists each one under `release` |
| Versioned releases | Push a tag such as `v2.0.0` → images tagged `2.0.0` and `2.0`, and a **GitHub Release** with run instructions, `docker-compose.release.yml` and `taskflow.env.example` |

Running a release needs only Docker and two files in one folder: `docker-compose.release.yml` and `.env` (a copy of `.env.example`). The version and port are **lines in `.env`** (`TASKFLOW_TAG=2.0.0`, `FRONTEND_PORT=3002`), so the same command works in PowerShell, macOS Terminal and Linux shells:

```bash
docker compose -f docker-compose.release.yml up -d --wait
```

Step-by-step Windows and macOS/Linux commands are in the [README](../README.md#run-the-released-version-no-build). A GitHub Release is a download; nothing is hosted, so `localhost` works only once it's running.

This repository also holds another capstone project, so GitHub's "latest release" can belong to either. **Plain `v*` tags (v1.0.0, v1.0.1, v2.0.0…) belong to FS-04** and start this pipeline's release job; other projects must use their own prefix (for example `fs01-v1.0.0`). The README's download commands name the FS-04 tag (`releases/download/v2.0.0/…`) rather than "latest" for the same reason.

`docker-compose.release.yml` mirrors `docker-compose.yml` but pulls the two app images instead of building them, and uses its own project name (`taskflow-release`) so it can't collide with a source-built stack on the same machine. It doesn't publish the database or stripe-mock ports at all.

## Live deployment (free, always on)

The public demo runs on free tiers only. Every option was compared first; the others failed on cost, capacity or "always on":

| Option (checked Nov 2026) | Why not |
|---|---|
| Oracle Cloud Always Free ARM | No ARM capacity in the Indian region for weeks |
| AWS Free plan EC2 | Credits only, account closes after 6 months; already used by another project |
| Google Cloud e2-micro | 1 GB RAM, US only, a billed account after the trial |
| Hugging Face Spaces (Docker) | Docker Spaces now need a paid plan |
| Fly.io, Railway, Koyeb | Trial credit or a card hold, not a free tier |
| Vercel, Netlify, Cloudflare Pages | Static sites only: no long-running API, worker, Postgres or Redis |
| Your own PC + Cloudflare Tunnel | Only online while the PC is on |

```mermaid
flowchart LR
  V[Visitor] -->|HTTPS| R
  subgraph R[Render free web service · one container · supervisord]
    N[nginx<br/>React build + /api proxy] --> G[Node.js API<br/>+ BullMQ worker in the same process]
    G --> RD[Redis<br/>in-memory]
    G --> SM[stripe-mock]
  end
  G --> DB[(Neon Postgres<br/>free, permanent)]
  U[UptimeRobot<br/>every 5 min] -->|/api/health/| R
  GH[GitHub Actions] -->|deploy hook + read-only smoke test| R
```

| Piece | Free tier | Why it fits |
|---|---|---|
| **Render web service** | 512 MB RAM, 0.1 CPU, 750 instance hours a month; sleeps after 15 min without traffic | Free plans have no background workers, so `deploy/render/Dockerfile` runs **every process in one container** under supervisord: nginx, the Node.js API with the BullMQ worker inside it (`EMBEDDED_WORKER=true`, one Node process instead of two), Redis and the stripe-mock binary. Measured: **about 255 MB** in use under a 512 MB / 0.1 CPU limit (v1 with Django: about 275 MB) |
| **Neon Postgres** | 1 GB, permanent, no card; scales to zero after 5 min idle | Render's free Postgres expires after 30 days; Neon doesn't. v2.0.0 uses a fresh database (`taskflow_node`) in the same Neon project, so v1's data stayed untouched for a rollback |
| **UptimeRobot** | 5-minute checks, email alerts | Its checks keep the Render service awake 24/7 (~744 of the 750 free hours). `/api/health/` doesn't touch the database, so Neon still sleeps when nobody uses the app |

**Deploys:** after the published release is verified, the `deploy-server` job calls the Render deploy hook with `ref=<commit>`, waits until `/api/health/` reports that commit (`APP_VERSION`, taken from Render's `RENDER_GIT_COMMIT`), then runs `scripts/smoke-test.sh --read-only` against the live site (it signs in with the demo login and creates nothing). Render's own auto-deploy is turned off, so only tested commits go live.

**Inside the container:** every program runs as the non-root user `app` with `HOME=/home/app`, the system resolver prefers IPv4 (Render has no IPv6 route; Neon publishes both), and Redis and stripe-mock listen only inside the container.

**Container start-up** (`deploy/render/start.sh`): derives the site's URL from Render's `RENDER_EXTERNAL_HOSTNAME`, applies the Prisma migrations, then starts supervisord. A one-off `seed` program creates the demo companies if they're missing. A cold start takes about 2 minutes on 0.1 CPU; that only happens on a deploy or a platform restart. Render's health check uses `/healthz`, which nginx answers itself.

**Settings on the live site** (image defaults, plus two secrets set on Render): `DEBUG=false`, `DEMO_MODE=true`, `EMBEDDED_WORKER=true`, `STRIPE_MOCK=true`, `TRUSTED_PROXY_COUNT=4` (measured on the live site: Cloudflare's edge, Render's load balancer, Render's proxy and our nginx each add an `X-Forwarded-For` entry; with 4 the audit log records the visitor's real IP and a spoofed header is ignored), and the secrets `DATABASE_URL` (Neon) and `DJANGO_SECRET_KEY` (still read under its v1 name; `SECRET_KEY` also works).

**Demo mode:** the published demo logins can't change their password or profile. The demo companies are rebuilt every night at 02:30 IST, and accounts or workspaces visitors create are removed after 7 days (see [Security](10-security.md)).

**Limits:** pages are slower than locally (0.1 CPU); attachments uploaded on the live site are lost on redeploy (the container disk isn't permanent); free tiers can change, and UptimeRobot emails you if the site goes down.

## Cost

Everything uses free tiers: Docker Desktop, GitHub Actions minutes, GitHub Container Registry (public images), Stripe's stripe-mock, and for the live site Render (free web service), Neon (free Postgres) and UptimeRobot (free monitoring). Nothing is billed unless a plan is upgraded by hand.
