# 10-Minute Final Presentation — Outline

[← 14-day commit plan](COMMIT_PLAN.md) · [Index](../README.md) · [Next: Reflection template →](REFLECTION_TEMPLATE.md)

| Time | Slide | Talking points |
|---|---|---|
| 0:00–1:00 | **Problem** | Teams need Jira-style tracking; a SaaS must serve many companies from one deployment without leaking data between them, and charge for it. |
| 1:00–2:30 | **Architecture** | `docs/assets/architecture.png` (or [03 · Architecture](../03-architecture.md)): React → nginx → Django REST → PostgreSQL; Celery + Redis for async; Stripe for billing; Docker + GitHub Actions. |
| 2:30–3:30 | **Tenant isolation** | Shared schema + `workspace_id`; `X-Workspace` header → membership lookup; queryset filtering; tenant-validated foreign keys; 404 instead of 403 so tenant names don't leak. Show the isolation test. |
| 3:30–6:00 | **Live demo** | Log in as owner → drag cards (blocked transition greys out) → open issue, comment, attach a file → history tab → audit log → add webhook (webhook.site) and watch the delivery → generate report → billing: hit the 2-project limit (402) → upgrade via the mock Stripe checkout → limit lifted. Explain that Stripe is invite-only in India, so the app runs on Stripe's official stripe-mock with real signed webhooks. Log in as viewer to show read-only. |
| 6:00–7:30 | **Challenges** | e.g. ordering cards during drag-and-drop (rank + reindex in a transaction, optimistic UI with rollback); firing webhooks only after the DB commit (`transaction.on_commit`); idempotent Stripe webhooks; N+1 queries on the board endpoint; Stripe being invite-only in India → mock mode; bugs found by testing ([12 · Testing](../12-testing.md)). |
| 7:30–8:45 | **Results** | 130 backend tests (96% coverage, CI fails below 90%) + 19 frontend tests, all run by CI on every push; the backend suite runs in ~32 s; board endpoint uses 7 SQL queries regardless of issue count (~48 ms), enforced by a test; bugs found in code review and fixed with regression tests ([12 · Testing](../12-testing.md)); screenshots of a green pipeline. |
| 8:45–10:00 | **Next steps** | Email invitations, real-time board updates (WebSockets), S3 storage for attachments, PostgreSQL row-level security as a second isolation layer, search, burndown charts. |
