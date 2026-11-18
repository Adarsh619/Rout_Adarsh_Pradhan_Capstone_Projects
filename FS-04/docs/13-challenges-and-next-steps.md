# 13 · Challenges and next steps

[← Testing and performance](12-testing.md) · [Index](README.md) · [Next: Setup →](14-setup.md)

The hardest parts were keeping card order consistent during drag-and-drop, guaranteeing tenant isolation, and building billing without access to Stripe.

## Challenges and decisions

| Challenge | Decision or fix |
|---|---|
| Card order during concurrent drags | Float `rank` per card; the destination column is re-numbered inside one locked transaction; the UI updates optimistically and rolls back on error |
| Isolation that cannot be forgotten | One middleware owns the tenant lookup; every query and every referenced id is scoped to the workspace; a test checks every resource from another workspace |
| Webhooks for changes that roll back | Queue deliveries only after the transaction commits (`unit.after()`; `transaction.on_commit` in v1) |
| Duplicate Stripe events | Store processed event IDs; a repeat returns "duplicate" without changing anything |
| Stripe is invite-only in India | Mock mode on Stripe's official `stripe-mock` with properly signed webhooks; real keys still work |
| N+1 queries on the board | A fixed set of queries whatever the board's size (7 in v1, 11 with Prisma), asserted by a test |
| Project in a repo subfolder | CI workflow at the repo root with `FS-04/` path prefixes and path filters |
| Stripe events arrive late, twice or out of order | Remember the time of the last event applied per subscription; ignore older ones and ones for other subscriptions; mark an event processed only if applying it succeeds |
| Webhook URLs can point inside our network (SSRF) | Only public http(s) addresses; resolve the host again before every delivery; no redirects |
| Drop position on a filtered board | Send the neighbouring card's id, not just an index, because hidden cards shift the index |
| The required tools changed after the build was done | Rebuilt on the required stack behind a frozen API contract, on a separate branch, with the tests ported first (see below) |
| Code committed in one go | Review each area on its own day, fix what the review finds with a test, and commit that as the day's work (log below) |

## Bugs found by testing

| Bug | Found by | Fix |
|---|---|---|
| The Stripe webhook handler would have crashed on real Stripe events: newer Stripe SDK objects are not dictionaries | Testing against `stripe-mock` with properly signed payloads; earlier tests faked the events | Parse the raw JSON after verifying the signature |
| Deleting a workspace (and re-seeding demo data) failed on protected links | End-to-end re-seeding | `delete_workspace()` removes issues and projects first, in one transaction |
| A cancelled plan still showed a renewal date | Browser test of billing | Clear the period end on cancellation |

## Day-by-day review (Days 2–14)

All code was first committed together, so instead of re-committing it file by file, each day took one area, reviewed it, fixed what was wrong, added tests and updated these docs. Each row is one commit on `main`.

| Day | Area | Commit | Main findings and fixes |
|---|---|---|---|
| 2 | Accounts | `0a0916d` | Login failed for `Owner@Acme.test`; admin's add-user form created users without email; no rate limit on login; weak passwords accepted; no logout or password change. Added rotating refresh tokens with revocation |
| 3 | Tenancy | `91f85e3` | Removed members kept getting emails about issues; any admin could demote other admins; added leaving a workspace and ownership transfer; workspace renames audited |
| 4 | Data model | `a60578f` | Two sprints could be active at once; deleted attachments left files on disk; cross-workspace links possible through Django admin; database constraints added |
| 5 | Issues API | `8f7c77b`, `375e95b` | Status changes in the issue form skipped the move logic; `?assignee=abc` crashed the board; issues could join closed sprints; any member could delete anyone's issue (now reporter or admin, with "ask an admin") |
| 6 | Audit | `a476143` | A fake `X-Forwarded-For` header could set the audit IP and dodge the login limit; the append-only log could be edited in admin; added filters and CSV export |
| 7 | Tests and seed | `1d4c476` | Suite took 3.5 min (now ~45 s); coverage gate at 90%; real query-count assertion for the board; seed data made consistent and protected from production |
| 8 | Webhooks and jobs | `d2dfdc4` | Webhooks could reach internal services (SSRF); event list incomplete; permanent errors retried; added secret rotation, redelivery, log clean-up |
| 9 | Billing | `126214b` | A late "deleted" event could downgrade a paying workspace; a failed event was still marked processed; two quick Upgrade clicks could create two subscriptions |
| 10 | React foundation | `198890c` | Login forgot the page you came from; a proxy's HTML error page crashed the API client; expired sessions left broken pages; dialogs not keyboard-accessible; notification polling in hidden tabs |
| 11 | Kanban board | `74462c7` | Drops on a filtered board landed among hidden cards; double-click created duplicate issues; backlog showed only the first 100 issues; search raced |
| 12 | Admin pages | `6c09d55` | Destructive actions on one click; admin pages blank for members; first workflow rule silently blocked every move; report refresh guessed a delay |
| 13 | Docker and CI | `7f58ebb` | Images never started in CI (now a Compose smoke test); `.venv` copied into the image; workers could start before migrations; database port open to the network; nginx caching and headers |
| 14 | Docs | `74ac210` | README, index, overview, features and this log brought up to date with Days 2–13 |
| 14+ | Account page | `73583a9` | Password change was API-only: added an account page (name, password) and fixed password hints being read as part of the field's name |
| 14+ | Release pipeline | `f723be1` | "Deploy" did nothing but print a notice: the pipeline now publishes multi-arch images, **verifies the published images by running them**, records the deployment, and turns `v*` tags into GitHub Releases; `docker-compose.release.yml` runs any release with one command |

| 14+ | Live site | `3b2dadc` | Free, always-on hosting: all-in-one container on Render + Neon Postgres + UptimeRobot, verified under Render's 512 MB / 0.1 CPU limits first; demo mode (locked demo logins, nightly reset, visitor clean-up); CI deploys tested commits and smoke-tests the live site. **Found on the way:** `kombu` 5.7.0 (released after v1.0.1) imports `packaging` without declaring it, so any fresh image had a Celery worker that crashed on start. Pinned `kombu==5.6.2`, and the smoke test now runs a real Celery job so this can't slip through again. **Found on the first live deploy:** every login failed with 500 because the processes ran as user `app` with root's `HOME`, and on Neon's SSL connection libpq treats "permission denied" on `/root/.postgresql` as fatal (local Postgres has no SSL, so tests passed). Fixed by giving each process its own `HOME`, reproduced and verified against an SSL-only Postgres; the container also prefers IPv4 (Render has no IPv6 route). The smoke script had let a failed check through, so every check now stops it with an error. The audit log first recorded Render's internal IP: Render sits behind Cloudflare, so there are 4 proxies, not 2; `TRUSTED_PROXY_COUNT=4` was measured on the live site (real IP recorded, spoofed header ignored) |
| 15 | Stack migration (v2.0.0) | branch `fs04-node` | The brief's required tools changed: backend rebuilt in Node.js, Express, TypeScript and Prisma with the same API contract, frontend converted to strict TypeScript, all tests ported to Vitest, Docker, CI and the live image updated; see [Stack migration](#stack-migration-to-nodejs-and-typescript-v200) |

## Stack migration to Node.js and TypeScript (v2.0.0)

**Why.** On 17 Nov 2026 the brief's list of required tools changed to React, TypeScript, Node.js, Express, PostgreSQL, Prisma, Vitest and Docker. v1.0.1 used Django, Django REST Framework, Celery and JavaScript React, so the backend had to be rebuilt and the frontend converted. (Steps 2 and 5 of the brief still name Django REST Framework and Celery; they are met with their Node.js counterparts: Express routes with role permissions, and BullMQ jobs.)

**How, without breaking what worked.**

1. The Django version was committed as a checkpoint, and the work happened on a separate branch (`fs04-node`). The live site kept running v1 until v2 had passed every check.
2. Before deleting any Django code, the responses of the running v1 API were saved as reference. The Node.js API keeps **the same URLs, field names, ids, pagination and error shapes**, and was compared with them field by field. That's why the React app needed types but no logic changes, and why the old smoke test kept working.
3. Each Django part was rebuilt as its Node.js counterpart:

| v1 (Django) | v2 (Node.js) |
|---|---|
| Django models + migrations | Prisma schema + migrations; raw SQL for what Prisma can't express (partial unique indexes, a check constraint, the audit trigger) |
| DRF serializers + viewsets | Express routers with Zod validation and hand-written response mappers |
| `TenantScopedMixin`, DRF permissions | `useWorkspace` middleware, `need(req, role)`, workspace-scoped lookups |
| SimpleJWT + token blacklist | `jose` JWTs + a `refresh_tokens` table (rotation and revocation in one conditional update) |
| `transaction.on_commit` | `inTransaction()` with after-commit hooks |
| Celery worker + beat | BullMQ worker (jobs and schedule in one process) |
| Stripe Python SDK | Stripe Node.js SDK, the same `stripe-mock` and the same signed-webhook handling |
| Python Faker seed | `@faker-js/faker` seed with the same shape (two companies, 60 issues per project, history) |
| pytest (185 tests) | Vitest + Supertest (197 tests) on a real PostgreSQL |
| JavaScript React | TypeScript React (strict), Vite 7, Vitest 4 |

4. The 185 pytest tests were ported suite by suite, keeping each test's intent; the Node.js versions also cover parallel creates, a 404 for every resource from another workspace, and an OpenAPI contract test.
5. Docker, the CI pipeline and the live image were updated, then the whole stack was smoke-tested in Docker and the live image under Render's 512 MB / 0.1 CPU limits before the merge.

**What changed for the better:** the audit log is now append-only in the database itself (a trigger), not only in application code; the live container uses less memory (~255 MB instead of ~275 MB) because the worker runs inside the API process; the smoke test now walks through a full user flow; the frontend's types catch whole classes of mistakes at build time.

**What got worse or was dropped:** the board needs 11 SQL statements instead of 7, because Prisma loads each relation with its own `IN (…)` query instead of a join (still constant, whatever the board's size). The Django admin site is gone (Prisma Studio covers local inspection). The common-password list is shorter than Django's.

**Lessons:** freezing the API contract first made a full rewrite safe to check; porting the tests early caught the behaviour gaps (for example the exact error messages and the order of permission checks); a lock file written on Windows can miss packages that Linux installs need; and measuring the live image under the platform's limits before deploying again avoided surprises.

## Known limits

- Tokens are kept in `localStorage`; a production launch should move them to httpOnly cookies (see [Security](10-security.md)).
- A webhook host whose DNS changes between our check and the request (DNS rebinding) isn't fully covered.
- Rate limits are counted in memory, per API process, until a shared Redis store is configured.
- Attachments are stored on the server's disk volume; on the free live site that disk isn't permanent, so uploads disappear on redeploy.
- The live site runs on 0.1 CPU: pages are slower than locally, and a deploy or platform restart means about 2 minutes of start-up.
- The board doesn't update live; other people's moves appear after a reload or the next action.

## Next steps

- Email invitations for people who don't have an account yet
- Real-time board updates with WebSockets
- Attachment storage on S3-compatible object storage
- PostgreSQL Row-Level Security as a second isolation layer
- Full-text search, burndown charts and sprint velocity
- Browser end-to-end tests (Playwright) in CI, on top of the Compose smoke test
