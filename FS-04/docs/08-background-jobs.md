# 08 · Background jobs

[← Frontend](07-frontend.md) · [Index](README.md) · [Next: Billing →](09-billing.md)

Slow or external work runs on a Celery worker, with Redis as the queue, so API requests stay fast. Celery Beat triggers the scheduled jobs.

## Tasks (`apps/integrations/tasks.py`)

| Task | Trigger | What it does |
|---|---|---|
| `deliver_webhook` | After any audited change commits | Checks the receiver's host still resolves to a public address, signs and POSTs the event (no redirects followed), and logs every attempt with the status and response. Retries only what can succeed later (network errors, timeouts, failed DNS lookups, 5xx, 408, 429): up to 4 retries with backoff (30 s, 60 s, 120 s, 240 s). A 4xx or a blocked address isn't retried |
| `send_notification_emails` | Assignment, comment, card move, due soon, delete request | Emails the people involved (console output in development) |
| `send_due_date_reminders` | Daily, 07:00 UTC | Notifies assignees of open issues due tomorrow. Runs at most once a day per issue, so a Beat restart or a manual re-run doesn't email twice |
| `delete_old_webhook_deliveries` | Daily, 03:30 UTC | Deletes webhook delivery logs older than `WEBHOOK_DELIVERY_RETENTION_DAYS` (30) |
| `generate_all_weekly_reports` | Mondays, 06:00 UTC | Queues one report per workspace |
| `generate_weekly_report` | Weekly, or **Generate now** on the Reports page | Created, completed, open and overdue counts plus open issues per assignee; emailed to admins |

Schedules live in `CELERY_BEAT_SCHEDULE` in `backend/config/settings.py`.

## Fired only after the change is saved

Every change goes through one helper, `audit.services.record()`. It writes the audit entry and queues webhooks with `transaction.on_commit`. If the database change rolls back, no webhook is ever sent.

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

- With Docker: the `worker` and `beat` containers start automatically.
- Without Docker: `celery -A config worker -l info --pool=solo` (Windows needs `--pool=solo`) and `celery -A config beat -l info`, or set `CELERY_TASK_ALWAYS_EAGER=true` to run tasks inline.
