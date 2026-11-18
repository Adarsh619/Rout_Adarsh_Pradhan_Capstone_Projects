# 10-Minute Final Presentation — Outline

[← 14-day commit plan](COMMIT_PLAN.md) · [Index](../README.md) · [Next: Reflection template →](REFLECTION_TEMPLATE.md)

| Time | Slide | Talking points |
|---|---|---|
| 0:00–1:00 | **Problem** | Teams need Jira-style tracking; a SaaS must serve many companies from one deployment without leaking data between them, and charge for it. |
| 1:00–2:30 | **Architecture** | `docs/assets/architecture.png` (or [03 · Architecture](../03-architecture.md)): React (TypeScript) → nginx → Node.js/Express API → PostgreSQL via Prisma; BullMQ + Redis for async; Stripe for billing; Docker + GitHub Actions. |
| 2:30–3:30 | **Tenant isolation** | Shared schema + `workspaceId`; `X-Workspace` header → membership lookup; every query filtered by workspace; tenant-validated foreign keys; 404 instead of 403 so tenant names don't leak. Show the isolation test. |
| 3:30–6:00 | **Live demo** | Log in as owner → drag cards (blocked transition greys out) → open issue, comment, attach a file → history tab → audit log → add webhook (webhook.site) and watch the delivery → generate report → billing: hit the 2-project limit (402) → upgrade via the mock Stripe checkout → limit lifted. Explain that Stripe is invite-only in India, so the app runs on Stripe's official stripe-mock with real signed webhooks. Log in as viewer to show read-only. |
| 6:00–7:30 | **Challenges** | e.g. ordering cards during drag-and-drop (rank + reindex in a transaction, optimistic UI with rollback); firing webhooks only after the DB commit (after-commit hooks); idempotent Stripe webhooks; N+1 queries on the board endpoint; **the required tools changing after the build: rebuilt on Node.js/Express/TypeScript/Prisma behind a frozen API contract, on a separate branch, tests ported first**; Stripe being invite-only in India → mock mode; bugs found by testing ([12 · Testing](../12-testing.md)). |
| 7:30–8:45 | **Results** | 197 backend tests (Vitest + Supertest on real PostgreSQL, 96% line coverage, CI fails below 90%) + 62 frontend tests, all run by CI on every push, plus a whole-stack smoke test (sign-up to billing) on the source build, the published images and the live site; the board uses 11 SQL statements whatever its size, enforced by a test; the live container runs in ~255 MB of 512 MB. |
| 8:45–10:00 | **Next steps** | Email invitations, real-time board updates (WebSockets), S3 storage for attachments, PostgreSQL row-level security as a second isolation layer, search, burndown charts. |
