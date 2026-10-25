# 07 · Frontend

[← API reference](06-api.md) · [Index](README.md) · [Next: Background jobs →](08-background-jobs.md)

A React single-page app built with Vite. The workspace slug in the URL (`/w/<slug>/...`) decides which tenant every API call targets.

## Structure (`frontend/src`)

| Part | Responsibility |
|---|---|
| `api.js` | Fetch wrapper: adds the JWT and `X-Workspace` header, refreshes expired tokens, formats API errors |
| `auth.jsx` | Login, register and logout state |
| `components/Layout.jsx` | Sidebar and notifications bell; loads the workspace, members and projects and shares them through context |
| `workspace.jsx` | Workspace context and the `can(role, minimum)` helper that hides controls a role can't use |
| `components/IssueModal.jsx` | Create and edit issues; comments, attachments and history tabs |
| `boardLogic.js` | Pure functions for the board (allowed moves, card reordering), unit-tested |
| `pages/` | One file per screen (below) |

## Pages

| Route | Page | Who sees it |
|---|---|---|
| `/login`, `/register` | Sign in, create account and first workspace | Everyone |
| `/` | Workspace picker | Signed-in users |
| `/w/:slug` | Projects | All roles (create: admin) |
| `/w/:slug/p/:id/board` | Kanban board | All roles (drag: member+) |
| `/w/:slug/p/:id/sprints` | Backlog and sprints | All roles (manage: admin) |
| `/w/:slug/members` | Members and roles | All roles (manage: admin) |
| `/w/:slug/workflows`, `/webhooks`, `/audit` | Admin tools | Admin+ |
| `/w/:slug/reports` | Weekly reports | Member+ |
| `/w/:slug/billing` (+ `/billing/checkout`) | Plan, usage, upgrade; simulated checkout in mock mode | All roles (change: owner) |

## How drag-and-drop works

1. The board loads in one request: `GET /boards/{id}/columns/` returns every status column with its ordered issues and the workflow's allowed transitions.
2. When a drag starts, columns the workflow forbids are dimmed and refuse drops.
3. On drop, the card moves on screen at once (optimistic update), then `POST /issues/{id}/move/ {status, index}` saves it.
4. If the server rejects the move, the board snaps back and a message explains why.

The library is `@hello-pangea/dnd`, a maintained fork of `react-beautiful-dnd`; it supports keyboard dragging too.

## Other design choices

- No global state library: React context holds the workspace, and each page fetches what it needs.
- Light and dark themes through CSS variables; layout works down to phone width.
- Viewers see everything read-only because edit controls are hidden by role. The API enforces the same rules, so hiding is only a convenience.
