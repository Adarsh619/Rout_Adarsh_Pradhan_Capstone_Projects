# 02 · Features and roles

[← Overview](01-overview.md) · [Index](README.md) · [Next: System architecture →](03-architecture.md)

A user signs up, creates a company workspace, invites colleagues with a role, and runs projects on a board.

## Features

| Feature | What it does |
|---|---|
| Workspaces | Each company is a separate tenant with a unique slug (`/w/acme/...`). One user can belong to several workspaces. |
| Projects and boards | Each project has a key (`WEB`) and gets a board automatically. Issues are numbered per project (`WEB-42`). |
| Kanban board | Drag cards between columns and reorder them. Columns the workflow forbids are greyed out while dragging. |
| Custom workflows | Your own statuses (with a to-do / in-progress / done category) and the allowed moves between them. |
| Sprints | Plan, start (one active per project) and complete. Unfinished issues return to the backlog. |
| Issues | Type, priority, story points, due date, assignee, comments, file attachments and a change history. |
| Audit log | Who changed what and when, with old → new values. |
| Webhooks | Subscribe a URL to events; signed payloads, retries and a delivery log. |
| Notifications and reports | In-app bell and email; daily due-date reminders; weekly summary reports. |
| Billing | Free, Pro and Business plans with enforced limits and Stripe checkout. |

## Roles

Roles are per workspace, and each role includes everything below it.

| Role | Can do |
|---|---|
| Owner | Everything, plus billing and deleting the workspace |
| Admin | Projects, boards, sprints, workflows, members, webhooks, audit log, reports |
| Member | Create and edit issues, move cards, comment, attach files |
| Viewer | Read only |

The API enforces these rules (see [06 · API](06-api.md)); the React app also hides controls a role cannot use.

## Screenshots

| Board | Issue details |
|---|---|
| ![Kanban board](assets/screenshots/board.png) | ![Issue modal](assets/screenshots/issue.png) |
| **Billing** | **Simulated Stripe checkout** |
| ![Billing](assets/screenshots/billing.png) | ![Mock checkout](assets/screenshots/mock-checkout.png) |
