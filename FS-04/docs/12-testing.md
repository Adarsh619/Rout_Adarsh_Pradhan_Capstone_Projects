# 12 · Testing and performance

[← DevOps](11-devops.md) · [Index](README.md) · [Next: Challenges and next steps →](13-challenges-and-next-steps.md)

Recorded 19 Nov 2026 (v2.0.0, Node.js/TypeScript) on PostgreSQL 16 (Docker), Node 24 locally and in CI. CI runs the same suites on every push and pull request.

## Backend: Vitest + Supertest (197 tests, 96% line coverage)

```
cd backend && npm run test:coverage
Test Files 9 passed · Tests 197 passed
Statements 93.07% · Branches 78.86% · Functions 96.66% · Lines 95.84%
```

The tests call the real Express app through Supertest, on a real PostgreSQL database (`taskflow_test`, created and migrated by `tests/global-setup.ts`) and the real `stripe-mock` server, so they check the SQL, the constraints and the triggers too, not stand-ins. Every test starts from empty tables. Background jobs run inline (`JOBS_INLINE`) or are held and run by hand when a test needs to control a delivery; webhook receivers and DNS are replaced by stand-ins, so no test reaches the internet. CI fails if line coverage drops below 90%.

The suites were ported one by one from the v1 pytest suites (185 tests), keeping each test's intent and adding a few that the new code needed (cross-tenant 404 on every resource, the OpenAPI contract, parallel creates).

| Suite | What it proves |
|---|---|
| `auth.test.ts` | Login ignores email case; weak passwords rejected (short, common, numeric, like the email); `/me` can't change the email; **refresh tokens rotate and the old one stops working**; logout and password change revoke tokens; **login is rate-limited**; tampered or wrong-type tokens refused; register creates the workspace; 401 without a token; `X-Workspace` required; **a user in tenant B can't list, read, reference or impersonate tenant A** (404); you can't assign non-members; role matrix (viewer/member/admin) for issues, projects and the audit log; member management; only the owner deletes a workspace |
| `tenancy.test.ts` | **Removed or departed members get no more notifications** and their open issues are unassigned; only the owner manages admins; nobody is made owner through the members endpoint; the tenant comes from the header only; leaving; **ownership transfer**; workspaces created at the same moment get different slugs; slug rules; renames audited; your role per workspace; a new workspace gets the default workflow and Free plan |
| `audit.test.ts` | Client IP for 0, 1 and 2 trusted proxies; **a spoofed `X-Forwarded-For` can't fake the audit IP or dodge the login limit**; **entries can't be changed or deleted, even with SQL** (database trigger), but go with their workspace; the actor's email survives account deletion; filters by kind, person, search and date; paging; IPs hidden from the issue History tab; **CSV export** respects filters, neutralises formulas and is admin-only |
| `issues.test.ts` | Project creates its board and default workflow; unique ASCII keys; `WEB-1..N` numbering, **also under parallel creates**; issue defaults; audit diffs + history; priority sorts by severity; list filters and search; project stats; workflow change refused once a project has issues; drag-and-drop re-ordering; **workflow transitions enforced**; custom workflows; a status edit in the form **moves the card like a drag**; moves re-check the workflow against the current status; **a drop on a filtered board lands next to the card it was dropped by**; a workflow keeps one status; parents fixed after creation; sprint lifecycle; **two Start clicks leave one active sprint**; sprint dates; no issues in closed sprints; board filters; comments, notifications and author-only edits; attachments: upload, **tenant-checked download**, file deleted with the row, size limit |
| `rules.test.ts` | **Database rules**: one active sprint, one default workflow, sprint end after start; hex colours; ASCII project keys; links to another workspace's rows refused; **every tenant resource answers 404 to another workspace**; attachment files deleted with their issue or workspace, same-named files both kept, hostile file names can't leave the upload folder; **only the reporter or an admin can delete an issue**; `can_delete` per caller; "ask an admin" notifies admins and the owner by bell and email, once per unread request |
| `webhooks.test.ts` | **Internal URLs refused** (localhost, private ranges, cloud metadata, Docker service names, IPv4-mapped IPv6, decimal IPs), at save time and again before delivery when DNS points inside; redirects not followed; **retry policy** (5xx/408/429/network/DNS failure yes, 4xx and private addresses no, stop at 5 attempts); **HMAC signature** correct; event filtering; **the event list matches exactly what the app sends**; admin-only; secret rotation; edits audited; failed deliveries show the response and can be redelivered; delivery-log clean-up; due-date reminders once a day; reports generated on demand and emailed; notifications read state |
| `billing.test.ts` | Free plan limit → **402**, **also under parallel creates**; upgraded plan lifts limits; past-due falls back to Free; overview; 503 without Stripe; Checkout with the right price; owner-only; no second subscription; **real calls to `stripe-mock`**; webhooks signed exactly like Stripe signs them: **idempotent**, cancellation downgrades, payment failure → past-due, bad or wrong-secret signature → 400; **a late "deleted" for an old subscription can't downgrade a paying workspace**; older events ignored; checkout events never replace a different subscription; **a failure while applying an event is rolled back and Stripe's retry is applied**; Stripe's changes audited; **mock mode**: subscribe → change → cancel through signed webhooks |
| `demo.test.ts` | **Published demo logins can't change their password or profile on the live site** (visitors' own accounts can); `/me` tells the app it's a demo; the **nightly reset rebuilds vandalised demo data**; visitor data older than 7 days purged, demo data never; nothing happens outside demo mode; the reset is scheduled at 21:00 UTC; `/api/health/` answers **without a database query**; the Faker seed creates two isolated tenants, `--reset` works (with the append-only audit trigger), it refuses to run with `DEBUG=false`, seeded data follows the app's rules and has a realistic history; **the board uses the same number of queries for 20 and 60 issues, and no more than 11** |
| `openapi.test.ts` | **Every endpoint and method in `openapi.yaml` is served by the app**; the document is served at `/api/schema/` and browsable at `/api/docs/`; billing is fully described; unknown URLs say so |

## Frontend: Vitest + Testing Library (62 tests)

```
cd frontend && npm test
Test Files 13 passed · Tests 62 passed
```

The application code is strict TypeScript (`npm run lint` runs ESLint and `tsc` for the app and the tests). The suites are unchanged from v1 apart from types: `boardLogic.test.ts` (transition rules, optimistic card move without mutating input, the neighbour sent for a drop, overdue dates), `IssueCard.test.tsx`, `Board.test.tsx` (**filters read from the URL**, search waits for typing to pause, Enter opens a card), `IssueModal.test.tsx` (**a double click creates one issue**, only allowed statuses offered, files over 10 MB refused before upload, deleted-issue message, unsaved-changes prompt), `api.test.tsx` (error formatting; HTML 502 pages and an unreachable server give readable errors; parallel requests share one token refresh; a dead session signs out and announces it), `auth.test.tsx` (**back to the requested page after login**, session-expired notice, retry when the server is down at start-up, 404 page), `Modal.test.tsx` (focus in and back out, Tab trapped, Escape and backdrop close), `Notifications.test.tsx` (**no polling while the tab is hidden**), `Account.test.tsx` (**password change keeps this session**, the shared demo login is read-only), `adminPages.test.tsx` (**admin pages explain instead of failing for lower roles**; workflow warnings; Reports waits for the worker; simulated checkout), `billingMessages.test.ts`, `DeleteIssueControls.test.tsx`, `auditFormat.test.ts`.

## Whole-stack smoke test

`scripts/smoke-test.sh` runs against a running stack through nginx: the app page, API health, schema and docs, security headers, then **sign-up, a project with its board, an issue (`SMK-1`), a drag to the next column, a comment, the audit log entry, a mock Stripe checkout through signed webhooks, and a report built by the background worker**. CI runs it on the source-built stack and again on the published images; the live site gets the read-only version (demo sign-in, no data created). Local result for v2.0.0: all 13 checks passed on the Compose stack and on the live-site image running with 512 MB / 0.1 CPU.

## Contract check against v1

Before the Django code was removed, the responses of every main endpoint of the running v1.0.1 stack were saved, then compared field by field with the Node.js API on the same demo data: same status codes, same top-level fields and same field types for all 30 requests (lists, details, errors, 401/403/404, validation errors). The web app's API client and screens needed no logic changes.

## Performance

| Measurement | Result |
|---|---|
| `GET /boards/{id}/columns/` with 60 issues | **11 SQL statements**, ~40–50 ms warm (Supertest, Docker Postgres). The same count for 20 issues: it doesn't grow with the board. Prisma loads each relation with its own `IN (…)` query (v1's Django used joins: 7 queries) |
| `GET /api/health/` | 0 SQL statements |
| Live-site container (API + worker + Redis + stripe-mock + nginx) | ~255 MB of 512 MB (v1: ~275 MB); ready ~2 min after start on 0.1 CPU |
| Local Compose stack | API ~155 MB, worker ~115 MB |
| Production JS bundle | 338 kB (106 kB gzipped) |

The query count is an **assertion**: the performance test fails if the board needs more than 11 statements, or more for 60 issues than for 20. Run `SHOW_SQL=1 npx vitest run tests/demo.test.ts -t "query count"` to print them.

## Bugs found during the move to Node.js (v2.0.0)

| Bug | How it was found | Fix |
|---|---|---|
| The rate limiter keyed IPv6 visitors by their full address, so one host could rotate through its range and dodge the login limit | `express-rate-limit` refused to start with the custom key | Use its `ipKeyGenerator` (groups IPv6 by /56) |
| The board made 13 SQL statements: Prisma reloaded the statuses and project for every issue list although the route already had them | The performance assertion (budget 12) failed | Load only the people with the issues; reuse the statuses and project: 11 |
| `npm ci` failed in the Linux Docker build: the lock file written on Windows lacked two optional WebAssembly packages | The first `docker compose build` | Lock files generated inside a Linux container |
| The JavaScript Faker writes Latin `lorem` text, so the demo had Latin issue titles (v1 had English) | Looking at the seeded board in the browser | English titles from task verbs and Faker's software vocabulary |
| The v1 "append-only" audit log was enforced only in Django code; a raw SQL statement could still change it | Re-reading the rule while porting | A database trigger refuses updates and deletes (cascades from deleting a workspace or user still work) |

## Bugs found in v1 (Django), kept as history

The table below lists what testing and the Days 2–12 review found in v1. Each fix and its regression test were carried over to v2.

| Area | Bug | Fix |
|---|---|---|
| Billing | The Stripe webhook handler called `.get()` on Stripe event objects, which real events would have crashed | Verify the signature, then parse the raw JSON; tests sign payloads exactly like Stripe |
| Tenancy | Deleting a workspace failed because projects and issues protect their workflow rows | Delete issues and projects first, in one transaction |
| Billing | After cancelling, the Free plan still showed a renewal date | Clear the period end on cancellation |
| Accounts | Login failed for `Owner@Acme.test` although the account was stored as `owner@acme.test` | Case-insensitive login |
| Tenancy | Removed members kept receiving emails with issue titles | Notify current members only; unassign their open issues |
| Tenancy | Any admin could demote or remove other admins | Admin changes are owner-only |
| Tracker | Two Start clicks at once could leave two active sprints | Partial unique index |
| Tracker | Deleted attachments, issues and workspaces left their files on disk | Delete files after the rows |
| Issues API | Changing status in the issue form left the card at a random position and sent no "moved" notification | Status edits go through the move logic |
| Issues API | `?assignee=abc` on the board returned a 500 | Validated, 400 |
| Audit | A fake `X-Forwarded-For` header set the recorded IP and reset the login rate limit | Trust only our proxy's entry |
| Web | A proxy's HTML error page (nginx 502) crashed the API client | Non-JSON bodies give a readable message |
| Web | A dead session left you on a page full of 401 errors | Sign out with a notice on 401 only; Try again otherwise |
| Board | On a filtered board a dropped card could land far from where it was dropped | The move names the neighbouring card (`after`/`before`) |
| Board | Double-clicking **Create issue** created the issue twice | Button disabled while saving |
| Backlog | Projects with more than 100 issues showed only the first 100 | `api.all()` loads every page |
| Admin pages | A member opening an admin page by URL got a blank page and 403 errors | `RequireRole` explains which role is needed |
| Workflows | Adding the first transition silently blocked every other move | A warning first |
| Reports | **Generate now** refreshed after a fixed delay, so a slower worker's report didn't appear | Checks until it appears |
| Checkout | A link with `?plan=free` crashed the simulated checkout | Falls back to Pro |
