# 10 · Security

[← Billing](09-billing.md) · [Index](README.md) · [Next: DevOps →](11-devops.md)

Security rests on four checks run on every request: who you are, which tenant you are in, what your role allows, and whether referenced objects belong to that tenant.

| Concern | Measure | Where |
|---|---|---|
| Authentication | JWT access tokens (60 min) and refresh tokens (7 days), signed with HS256 using `SECRET_KEY` (`jose`); emails stored lower-case and matched case-insensitively at login; an unknown email takes as long as a wrong password, so login doesn't reveal which emails have accounts | `src/modules/auth/tokens.ts`, `src/modules/auth/routes.ts` |
| Passwords | Hashed with bcrypt (10 rounds). Rejected if shorter than 8 characters, all digits, on a built-in list of the most common passwords, or too similar to the user's email or name (the same rules and messages as v1's Django validators; the common-password list is shorter than Django's 20,000). Checked at registration and password change | `src/modules/auth/passwords.ts` |
| Sessions | Every refresh token is recorded in the `refresh_tokens` table. Refresh tokens rotate: every refresh returns a new one and revokes the old one, in one conditional update, so two refreshes racing with the same token can't both succeed. Logout revokes the current refresh token; a password change revokes all of them. Access tokens can't be revoked and simply expire. When a session can't be renewed, the web app clears its tokens and returns to the login page | `src/modules/auth/tokens.ts` |
| Tenant isolation | Membership lookup on every request, from the `X-Workspace` header only; every query filtered by `workspaceId`; every id in a request looked up within the same workspace; 404 for outsiders (a test checks every resource) | `src/modules/tenancy/context.ts`, `src/modules/tracker/common.ts` |
| Former members | Removal or leaving unassigns the person's open issues; notifications and emails go only to current members, so ex-members receive nothing about the workspace | `removeMember()` in `src/modules/tenancy/services.ts`, `src/modules/integrations/notify.ts` |
| Authorisation | Role ladder checked per action; comments and attachments editable only by author or admin; only the owner manages billing, grants or removes the admin role, transfers ownership or deletes a workspace. The members endpoint can't make anyone owner | `need()` in `src/modules/tenancy/context.ts`, `src/modules/tenancy/routes.ts` |
| Incoming Stripe webhooks | Signature verified with the webhook secret; bad or wrong-secret signatures return 400; duplicate, out-of-order and other-subscription events ignored; an event is only marked processed if applying it succeeds | `processWebhook()` in `src/modules/billing/stripe.ts` |
| Outgoing webhooks | Each hook has its own secret, which admins can rotate; payloads carry an HMAC-SHA256 signature | `src/modules/integrations/jobs.ts` |
| Server-side request forgery (SSRF) | Webhook URLs are sent from inside our network, so a URL pointing at `localhost`, `db`, `redis`, a private range or the cloud metadata address (169.254.169.254) could reach internal services and show their replies in the delivery log. URLs must be public http(s) with no credentials; the host is resolved again before every delivery and every address must be public; redirects aren't followed. `WEBHOOK_ALLOW_PRIVATE_URLS=true` turns this off, for testing against a receiver on your own machine only. IPv4-mapped IPv6 and numeric forms such as `http://2130706433/` (127.0.0.1) are recognised too. A host whose DNS changes between our check and the request (DNS rebinding) is not fully covered | `src/modules/integrations/urlsafety.ts` |
| Attachments | Max 10 MB; stored per workspace and issue; file names cleaned so they can't leave the upload folder; downloaded only through an authenticated, tenant-checked endpoint | `src/modules/tracker/attachments.ts`, `src/modules/tracker/files.ts` |
| Abuse | API rate limit, 2,000 requests/hour per user (`API_RATE_LIMIT`). Register, login and password change are limited to 10 requests/minute per IP address, or per user once signed in (`AUTH_RATE_LIMIT`), which slows password guessing; over the limit returns 429. IPv6 visitors are counted per /56 network, so one host can't rotate through its addresses | `express-rate-limit` in `src/app.ts` |
| Secrets | Read from `.env`, which Git ignores; the API refuses to start without `SECRET_KEY` when `DEBUG` is off; containers run as a non-root user | `.gitignore`, `src/config.ts`, `backend/Dockerfile` |
| Accountability | Audit log with actor, IP address and field-level changes. It's **append-only in the database**: a trigger refuses every `UPDATE` and `DELETE` on `audit_logs`, whatever code (or person with SQL access) sends it; only the cascades from deleting a workspace or a user get through. There is no API route to change an entry. Each entry keeps the actor's email, so it still says who acted after their account is deleted. IP addresses are visible to admins only (the audit log page and CSV), not in an issue's History tab | `src/modules/audit`, the first migration in `prisma/migrations/` |
| Client IP | Browsers can send any `X-Forwarded-For` header, and nginx appends the real address to it. `TRUSTED_PROXY_COUNT` (1 in Docker Compose, 0 by default) says how many proxies to trust, and the address is read from the right-hand end, the entry our own proxy added. Express applies it through its `trust proxy` setting, which the audit log and the rate limits both use, so a made-up header can neither fake an audit IP nor dodge the login limit | `src/app.ts`, `clientIp()` in `src/modules/audit/service.ts` |
| CSV export | Cells that start with `=`, `+`, `-` or `@` are prefixed with `'`, so a spreadsheet shows a formula-like issue title or sprint name as text instead of running it | `csvSafe()` in `src/modules/audit/routes.ts` |

## Public demo site (`DEMO_MODE=true`)

The live demo publishes its logins (`owner@acme.test` / `demo12345` and the other seeded users), so anyone can use them:

| Risk | Protection |
|---|---|
| A visitor changes a demo password and locks everyone else out | Demo logins (`@acme.test`, `@globex.test`) can't change their password or profile: 403 with an explanation, and the Account page is read-only for them (`src/modules/auth/demo.ts`) |
| Visitors delete or vandalise the demo data | Every night at 02:30 IST, the worker's schedule rebuilds both demo companies and resets their passwords (`resetDemoData()` in `src/modules/demo/jobs.ts`) |
| Visitors' own sign-ups pile up | Workspaces and accounts visitors create are deleted after `DEMO_VISITOR_RETENTION_DAYS` (7) |
| Someone thinks it's private data | A banner on every page says it's a shared demo that resets nightly |

Outside demo mode (local, CI) these accounts behave like any other.

## Before a real production launch

- Set `DEBUG=false`, a long random `SECRET_KEY`, and an exact `CORS_ALLOWED_ORIGINS`.
- Build the frontend with `VITE_DEMO_HINT=false` so the sign-in page doesn't show the demo login.
- Serve over HTTPS and store tokens in httpOnly cookies instead of `localStorage`.
- Move attachments to private object storage with signed URLs.
- Keep the rate-limit counters in Redis (`rate-limit-redis`) if more than one API process runs; the in-memory counters count per process.
- Delete expired rows from `refresh_tokens` regularly (a daily job, like v1's `flushexpiredtokens`).
- Set `TRUSTED_PROXY_COUNT` to the number of proxies in front of the API (e.g. 2 for a load balancer plus nginx), and don't expose port 8000 publicly. The setting only holds if every request passes through those proxies; Docker Compose publishes port 8000 for local development only.
