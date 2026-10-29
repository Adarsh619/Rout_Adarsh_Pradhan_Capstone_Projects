# 06 · API reference

[← Data model](05-data-model.md) · [Index](README.md) · [Next: Frontend →](07-frontend.md)

Interactive docs: **`/api/docs/`** (Swagger UI). Machine-readable schema: [`openapi.yaml`](openapi.yaml).

## Conventions

- Auth: `Authorization: Bearer <access JWT>` (from `/api/auth/token/` or `/api/auth/register/`)
- Tenant: `X-Workspace: <workspace slug>` on every endpoint except `auth/*`, `workspaces/*` and the Stripe webhook
- Lists are paginated (`?limit=&offset=`) and support `?search=` and `?ordering=` where noted

## Errors

| Status | Meaning |
|---|---|
| 400 | Validation error, including a move the workflow forbids |
| 401 | Missing or expired token |
| 402 | Plan limit reached; upgrade needed |
| 403 | Role too low for this action |
| 404 | Not found, or belongs to another workspace |
| 429 | Too many requests: over the API limit, or over the stricter limit on register, login and password change |

## Endpoints

| Method & path | Min. role | Description |
|---|---|---|
| `POST /api/auth/register/` | public | `{email, password, full_name?, workspace_name?}` → user + tokens (+ workspace slug) |
| `POST /api/auth/token/` | public | `{email, password}` → `{access, refresh}`. The email is matched case-insensitively |
| `POST /api/auth/token/refresh/` | public | `{refresh}` → `{access, refresh}`. Returns a **new** refresh token; the old one is blacklisted and gets 401 if reused |
| `POST /api/auth/logout/` | public | `{refresh}` → blacklists that refresh token. The access token stays valid until it expires (max 60 min) |
| `GET/PATCH /api/auth/me/` | user | Current profile; only `full_name` can be changed |
| `POST /api/auth/password/` | user | `{current_password, new_password}` → new `{access, refresh}`. Revokes every refresh token you held before |
| `GET/POST /api/workspaces/` | user | Your workspaces / create one (you become owner) |
| `GET/PATCH/DELETE /api/workspaces/{slug}/` | viewer / admin / owner | Workspace detail; PATCH `{name}` is audited as `workspace.updated` |
| `POST /api/workspaces/{slug}/transfer/` | owner | `{user_id}` of another member → they become owner, you become admin |
| `GET/POST/PATCH/DELETE /api/members/` | viewer read, admin write | Add by `{email, role}` (user must exist); the owner can't be changed or removed. Granting, changing or removing the **admin** role needs the owner (403 otherwise). Removing someone unassigns their open issues |
| `POST /api/members/leave/` | viewer | Leave the current workspace (204); open issues are unassigned. The owner gets 400 and must transfer ownership first |
| `/api/workflows/` · `/api/statuses/?workflow=` · `/api/transitions/?workflow=` | admin write | Custom workflows. A status's `workflow` is fixed after creation; a workflow's last status can't be deleted (400) |
| `/api/projects/` | admin write | Creating one also creates its board; `GET /projects/{id}/stats/` |
| `/api/boards/?project=` | admin write | `GET /boards/{id}/columns/?sprint=all\|active\|backlog\|<id>&assignee=<id>&q=` → columns with ordered issues, allowed transitions, active sprint. Any other `sprint` value, or a non-numeric `assignee`, is a 400. A board's `project` is fixed after creation |
| `/api/sprints/?project=&state=` | admin write | `POST /sprints/{id}/start/`, `POST /sprints/{id}/complete/` (one transaction). A sprint's `project` is fixed after creation |
| `/api/issues/?project=&status=&assignee=&sprint=&type=&priority=&backlog=true` | member write | CRUD; `search`, `ordering` (`priority` sorts low → critical, `-priority` the reverse); `POST /issues/{id}/move/ {status, index}`; `GET /issues/{id}/history/`. Changing `status` with PATCH works like a move: the card goes to the bottom of the new column and it's logged and notified as `issue.moved`. Issues can't be added to a closed sprint. **DELETE** needs the reporter or an admin (403 otherwise); each issue's `can_delete` field says whether the caller may delete it. `POST /issues/{id}/request_deletion/` (member) notifies admins and the owner → 202 `{notified}`, or 200 `{already_requested: true}` if your last request is still unread; 400 if you can delete it yourself |
| `/api/comments/?issue=` | member write | Only the author or an admin can edit or delete. A comment's `issue` is fixed after creation |
| `/api/attachments/?issue=` | member write | Multipart upload `{issue, file}` (max 10 MB); `GET /attachments/{id}/download/` |
| `GET /api/audit-logs/?kind=&action=&actor_email=&since=&until=&search=&entity_type=&entity_id=` | admin | Audit trail, newest first, paginated (`limit`/`offset`). `kind` is the part of the action before the dot (`issue`, `member`, `billing`…); `since`/`until` are inclusive UTC dates; `search` covers the entity label, action and person. Each entry includes `actor_email` and `ip_address`. `GET /audit-logs/export/` returns the same filtered entries as CSV (up to 10,000 rows) |
| `/api/webhooks/` | admin | CRUD; `GET /webhooks/events/`; `POST /webhooks/{id}/ping/`; `GET /webhooks/{id}/deliveries/` |
| `GET /api/notifications/` | viewer | Your notifications; `PATCH {read}`; `POST mark_all_read/`; `GET unread_count/` |
| `GET /api/reports/` · `POST /api/reports/generate/` | member / admin | Weekly summaries; generate queues a Celery task (202) |
| `GET /api/billing/` | viewer | Plan, status, limits, usage, plan catalogue |
| `POST /api/billing/checkout/ {plan}` · `POST /api/billing/portal/` | owner | Stripe Checkout / Customer Portal URLs |
| `POST /api/billing/stripe-webhook/` | Stripe signature | Subscription sync (idempotent) |
| `POST /api/billing/mock/complete/ {plan}` or `{action: "cancel"}` | owner, mock mode only | Simulate Stripe after checkout/portal: sends signed events through the webhook handler (404 when `STRIPE_MOCK=false`) |
| `GET /api/health/` | public | Liveness probe |

## Webhook payload

```http
POST https://your-endpoint
X-TaskFlow-Event: issue.moved
X-TaskFlow-Delivery: 42
X-TaskFlow-Signature: sha256=<hex HMAC-SHA256 of the raw body using the webhook secret>

{"event":"issue.moved","workspace":"acme","occurred_at":"2026-10-25T09:00:00+00:00",
 "data":{"entity":{"type":"issue","id":"17","label":"WEB-17 Fix login"},"changes":{"status":["To Do","In Progress"]},"actor":"owner@acme.test"}}
```

Verify it in Python:
```python
import hmac, hashlib
expected = "sha256=" + hmac.new(secret.encode(), raw_body, hashlib.sha256).hexdigest()
assert hmac.compare_digest(expected, request.headers["X-TaskFlow-Signature"])
```

Events: `issue.created|updated|moved|deleted`, `comment.created`, `attachment.created`, `sprint.started|completed`, `project.created|updated|deleted`, plus `ping`.
