# 08 · Background jobs

[← Frontend](07-frontend.md) · [Index](README.md) · [Next: Billing →](09-billing.md)

Slow or external work runs on a BullMQ worker, with Redis as the queue, so API requests stay fast. The same worker registers and runs the schedule (BullMQ job schedulers), so there is no separate scheduler process as v1 had with Celery beat.

## Jobs (`src/modules/integrations/jobs.ts`, `src/modules/demo/jobs.ts`)

| Job | Trigger | What it does |
|---|---|---|
| `deliver_webhook` | After any audited change commits | Checks the receiver's host still resolves to a public address, signs and POSTs the event (no redirects followed), and logs every attempt with the status and response. Retries only what can succeed later (network errors, timeouts, failed DNS lookups, 5xx, 408, 429): 5 attempts in all, with exponential backoff (30 s, 60 s, 120 s, 240 s). A 4xx or a blocked address isn't retried |
| `send_notification_emails` | Assignment, comment, card move, due soon, delete request | Emails the people involved (console output in development) |
| `send_due_date_reminders` | Daily, 07:00 UTC | Notifies assignees of open issues due tomorrow. Runs at most once a day per issue, so a worker restart or a manual re-run doesn't email twice |
| `delete_old_webhook_deliveries` | Daily, 03:30 UTC | Deletes webhook delivery logs older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (30) |
| `generate_all_weekly_reports` | Mondays, 06:00 UTC | Queues one report per workspace |
| `generate_weekly_report` | Weekly, or **Generate now** on the Reports page | Created, completed, open and overdue counts plus open issues per assignee; emailed to admins |
| `reset_demo_data` | Daily, 21:00 UTC (02:30 IST) | Only with `DEMO_MODE=true`: rebuilds the demo companies, then removes visitors' data older than 7 days |

The schedule (in UTC) is `SCHEDULE` in `src/jobs/registry.ts`, which also maps each job name to its function. Jobs carry only ids and re-read PostgreSQL, so a job that runs twice is harmless.

## Fired only after the change is saved

Every change goes through one helper, `record()` in `src/modules/audit/service.ts`, inside `inTransaction()`. It writes the audit entry and the delivery rows in the same transaction, and queues the jobs with `unit.after()`, which runs only once the transaction has committed. If the database change rolls back, no webhook is ever sent.

## Webhook events

32 events across issues, comments, attachments, projects, boards, sprints, workflows and members, plus `ping` for testing a hook. The full list is in [06 · API](06-api.md#webhook-payload); a test fails if the app sends an event that isn't listed, or the list names one that's never sent.
A webhook with an empty event list receives everything. The payload format and signature check are in [06 · API](06-api.md#webhook-payload).
If a webhook's secret leaks, **rotate** it on the Webhooks page; failed deliveries can be sent again with **Redeliver**.

## Notifications

| Verb | Who is notified |
|---|---|
| assigned | The new assignee |
| commented | Assignee and reporter, except the comment's author |
| moved | Assignee and reporter, except the person who moved it |
| due_soon | The assignee, the day before the due date |
| delete_requested | Every admin and the owner, except the member who asked (see [02 · Deleting issues](02-features-and-roles.md#deleting-issues)) |

Each creates an in-app notification (the bell polls every 30 s) and queues an email.

## Running locally

- With Docker: the `worker` container starts automatically.
- Without Docker: `npm run dev:worker` in `backend/`, or set `JOBS_INLINE=true` to run jobs inside the API process (no worker or Redis needed).
- On the live site the worker runs inside the API process (`EMBEDDED_WORKER=true`) to save memory.
