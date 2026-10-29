# 10 · Security

[← Billing](09-billing.md) · [Index](README.md) · [Next: DevOps →](11-devops.md)

Security rests on four checks run on every request: who you are, which tenant you are in, what your role allows, and whether referenced objects belong to that tenant.

| Concern | Measure | Where |
|---|---|---|
| Authentication | JWT access tokens (60 min) and refresh tokens (7 days); emails matched case-insensitively at login | `SIMPLE_JWT` in settings, `apps/accounts/models.py` |
| Passwords | Hashed by Django. Rejected if shorter than 8 characters, all digits, on Django's list of 20,000 common passwords, or too similar to the user's email or name. Checked at registration and password change | `AUTH_PASSWORD_VALIDATORS` in settings |
| Sessions | Refresh tokens rotate: every refresh returns a new one and blacklists the old one. Logout blacklists the current refresh token; a password change blacklists all of them. Access tokens can't be revoked and simply expire | `SIMPLE_JWT`, `token_blacklist` app, `apps/accounts/views.py` |
| Tenant isolation | Membership lookup on every request, from the `X-Workspace` header only; queries filtered by workspace; foreign keys validated per workspace; 404 for outsiders | `apps/tenancy/mixins.py`, `apps/tracker/serializers.py` |
| Former members | Removal or leaving unassigns the person's open issues; notifications and emails go only to current members, so ex-members receive nothing about the workspace | `apps/tenancy/services.py::remove_member`, `apps/integrations/notify.py` |
| Authorisation | Role ladder checked per action; comments and attachments editable only by author or admin; only the owner manages billing, grants or removes the admin role, transfers ownership or deletes a workspace. Django admin can't create a second owner or delete the owner's membership | `apps/tenancy/permissions.py`, `apps/tenancy/views.py`, `apps/tenancy/admin.py` |
| Incoming Stripe webhooks | Signature verified with the webhook secret; bad or wrong-secret signatures return 400; duplicate, out-of-order and other-subscription events ignored; an event is only marked processed if applying it succeeds | `apps/billing/services.py::process_webhook` |
| Outgoing webhooks | Each hook has its own secret, which admins can rotate; payloads carry an HMAC-SHA256 signature | `apps/integrations/tasks.py` |
| Server-side request forgery (SSRF) | Webhook URLs are sent from inside our network, so a URL pointing at `localhost`, `db`, `redis`, a private range or the cloud metadata address (169.254.169.254) could reach internal services and show their replies in the delivery log. URLs must be public http(s) with no credentials; the host is resolved again before every delivery and every address must be public; redirects aren't followed. `WEBHOOK_ALLOW_PRIVATE_URLS=true` turns this off, for testing against a receiver on your own machine only. A host whose DNS changes between our check and the request (DNS rebinding) is not fully covered | `apps/integrations/urlsafety.py` |
| Attachments | Max 10 MB; stored per workspace; downloaded only through an authenticated, tenant-checked endpoint | `AttachmentViewSet.download` |
| Abuse | API rate limit, 2,000 requests/hour per user (`API_RATE_LIMIT`). Register, login and password change are limited to 10 requests/minute per IP address, or per user once signed in (`AUTH_RATE_LIMIT`), which slows password guessing; over the limit returns 429 | `REST_FRAMEWORK` in settings, `AuthThrottleMixin` |
| Secrets | Read from `.env`, which Git ignores; containers run as a non-root user | `.gitignore`, `backend/Dockerfile` |
| Accountability | Audit log with actor, IP address and field-level changes. It's **append-only in code**: saving an existing entry, `delete()`, and bulk `update()`/`delete()` all raise `AppendOnlyError`, and Django admin can only view entries. Each entry keeps the actor's email, so it still says who acted after their account is deleted. IP addresses are visible to admins only (the audit log page and CSV), not in an issue's History tab | `apps/audit` |
| Client IP | Browsers can send any `X-Forwarded-For` header, and nginx appends the real address to it. `TRUSTED_PROXY_COUNT` (1 in Docker Compose, 0 by default) says how many proxies to trust, and the address is read from the right-hand end, the entry our own proxy added. The audit log and the rate limits (DRF `NUM_PROXIES`) use the same rule, so a made-up header can neither fake an audit IP nor dodge the login limit | `config/settings.py`, `apps/audit/services.py::client_ip` |
| CSV export | Cells that start with `=`, `+`, `-` or `@` are prefixed with `'`, so a spreadsheet shows a formula-like issue title or sprint name as text instead of running it | `apps/audit/views.py::csv_safe` |

## Before a real production launch

- Set `DJANGO_DEBUG=false`, a long random `DJANGO_SECRET_KEY`, and exact `DJANGO_ALLOWED_HOSTS` / `CORS_ALLOWED_ORIGINS`.
- Serve over HTTPS and store tokens in httpOnly cookies instead of `localStorage`.
- Move attachments to private object storage with signed URLs.
- Use a shared cache (Redis) so the rate limits count across all gunicorn workers; the default in-memory cache counts per worker.
- Run `python manage.py flushexpiredtokens` daily to remove expired entries from the token blacklist tables.
- Set `TRUSTED_PROXY_COUNT` to the number of proxies in front of Django (e.g. 2 for a load balancer plus nginx), and don't expose port 8000 publicly. The setting only holds if every request passes through those proxies; Docker Compose publishes port 8000 for local development only.
