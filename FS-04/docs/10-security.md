# 10 · Security

[← Billing](09-billing.md) · [Index](README.md) · [Next: DevOps →](11-devops.md)

Security rests on four checks run on every request: who you are, which tenant you are in, what your role allows, and whether referenced objects belong to that tenant.

| Concern | Measure | Where |
|---|---|---|
| Authentication | JWT access tokens (60 min) and refresh tokens (7 days); passwords hashed by Django; minimum length 8 | `SIMPLE_JWT`, `AUTH_PASSWORD_VALIDATORS` in settings |
| Tenant isolation | Membership lookup on every request; queries filtered by workspace; foreign keys validated per workspace; 404 for outsiders | `apps/tenancy/mixins.py`, `apps/tracker/serializers.py` |
| Authorisation | Role ladder checked per action; comments and attachments editable only by author or admin; only the owner manages billing or deletes a workspace | `apps/tenancy/permissions.py`, views |
| Incoming Stripe webhooks | Signature verified with the webhook secret; bad or wrong-secret signatures return 400; duplicate events ignored | `apps/billing/services.py::process_webhook` |
| Outgoing webhooks | Each hook has its own secret; payloads carry an HMAC-SHA256 signature | `apps/integrations/tasks.py` |
| Attachments | Max 10 MB; stored per workspace; downloaded only through an authenticated, tenant-checked endpoint | `AttachmentViewSet.download` |
| Abuse | API rate limit, 2,000 requests/hour per user (configurable with `API_RATE_LIMIT`) | `REST_FRAMEWORK` in settings |
| Secrets | Read from `.env`, which Git ignores; containers run as a non-root user | `.gitignore`, `backend/Dockerfile` |
| Accountability | Append-only audit log with actor, IP address and field-level changes | `apps/audit` |

## Before a real production launch

- Set `DJANGO_DEBUG=false`, a long random `DJANGO_SECRET_KEY`, and exact `DJANGO_ALLOWED_HOSTS` / `CORS_ALLOWED_ORIGINS`.
- Serve over HTTPS and store tokens in httpOnly cookies instead of `localStorage`.
- Move attachments to private object storage with signed URLs.
