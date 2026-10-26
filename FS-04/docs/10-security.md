# 10 · Security

[← Billing](09-billing.md) · [Index](README.md) · [Next: DevOps →](11-devops.md)

Security rests on four checks run on every request: who you are, which tenant you are in, what your role allows, and whether referenced objects belong to that tenant.

| Concern | Measure | Where |
|---|---|---|
| Authentication | JWT access tokens (60 min) and refresh tokens (7 days); emails matched case-insensitively at login | `SIMPLE_JWT` in settings, `apps/accounts/models.py` |
| Passwords | Hashed by Django. Rejected if shorter than 8 characters, all digits, on Django's list of 20,000 common passwords, or too similar to the user's email or name. Checked at registration and password change | `AUTH_PASSWORD_VALIDATORS` in settings |
| Sessions | Refresh tokens rotate: every refresh returns a new one and blacklists the old one. Logout blacklists the current refresh token; a password change blacklists all of them. Access tokens can't be revoked and simply expire | `SIMPLE_JWT`, `token_blacklist` app, `apps/accounts/views.py` |
| Tenant isolation | Membership lookup on every request; queries filtered by workspace; foreign keys validated per workspace; 404 for outsiders | `apps/tenancy/mixins.py`, `apps/tracker/serializers.py` |
| Authorisation | Role ladder checked per action; comments and attachments editable only by author or admin; only the owner manages billing or deletes a workspace | `apps/tenancy/permissions.py`, views |
| Incoming Stripe webhooks | Signature verified with the webhook secret; bad or wrong-secret signatures return 400; duplicate events ignored | `apps/billing/services.py::process_webhook` |
| Outgoing webhooks | Each hook has its own secret; payloads carry an HMAC-SHA256 signature | `apps/integrations/tasks.py` |
| Attachments | Max 10 MB; stored per workspace; downloaded only through an authenticated, tenant-checked endpoint | `AttachmentViewSet.download` |
| Abuse | API rate limit, 2,000 requests/hour per user (`API_RATE_LIMIT`). Register, login and password change are limited to 10 requests/minute per IP address, or per user once signed in (`AUTH_RATE_LIMIT`), which slows password guessing; over the limit returns 429 | `REST_FRAMEWORK` in settings, `AuthThrottleMixin` |
| Secrets | Read from `.env`, which Git ignores; containers run as a non-root user | `.gitignore`, `backend/Dockerfile` |
| Accountability | Append-only audit log with actor, IP address and field-level changes | `apps/audit` |

## Before a real production launch

- Set `DJANGO_DEBUG=false`, a long random `DJANGO_SECRET_KEY`, and exact `DJANGO_ALLOWED_HOSTS` / `CORS_ALLOWED_ORIGINS`.
- Serve over HTTPS and store tokens in httpOnly cookies instead of `localStorage`.
- Move attachments to private object storage with signed URLs.
- Use a shared cache (Redis) so the rate limits count across all gunicorn workers; the default in-memory cache counts per worker.
- Run `python manage.py flushexpiredtokens` daily to remove expired entries from the token blacklist tables.
- Behind a proxy, make sure the client IP DRF sees is the real one (`NUM_PROXIES`), or every user shares nginx's IP for the login limit.
