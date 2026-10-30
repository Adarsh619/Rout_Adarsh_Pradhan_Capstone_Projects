# 07 · Frontend

[← API reference](06-api.md) · [Index](README.md) · [Next: Background jobs →](08-background-jobs.md)

A React single-page app built with Vite. The workspace slug in the URL (`/w/<slug>/...`) decides which tenant every API call targets.

## Structure (`frontend/src`)

| Part | Responsibility |
|---|---|
| `api.js` | Fetch wrapper: adds the JWT and `X-Workspace` header, refreshes expired tokens (one shared refresh for parallel requests), turns every failure into a readable `ApiError` |
| `auth.jsx` | Login, register and logout state; reacts when the session expires |
| `App.jsx` | Routes; `Private` sends signed-out visitors to the login page and back afterwards; unknown addresses show a 404 page |
| `components/Layout.jsx` | Sidebar and notifications bell; loads the workspace, members and projects and shares them (with `reloadMembers`, `reloadProjects`, `reloadWorkspace`) through context |
| `components/Modal.jsx` | Accessible dialog used by the issue form |
| `components/Notifications.jsx` | Bell with unread count and a dropdown of recent notifications |
| `workspace.jsx` | Workspace context and the `can(role, minimum)` helper that hides controls a role can't use |
| `components/IssueModal.jsx` | Create and edit issues; comments, attachments and history tabs |
| `boardLogic.js` | Pure functions for the board (allowed moves, card reordering), unit-tested |
| `pages/` | One file per screen (below) |

## Pages

| Route | Page | Who sees it |
|---|---|---|
| `/login`, `/register` | Sign in, create account and first workspace | Everyone (signed-in users are sent on) |
| `/` | Workspace picker | Signed-in users |
| `/w/:slug` | Projects | All roles (create: admin) |
| `/w/:slug/p/:id/board` | Kanban board | All roles (drag: member+) |
| `/w/:slug/p/:id/sprints` | Backlog and sprints | All roles (manage: admin) |
| `/w/:slug/members` | Members and roles | All roles (manage: admin) |
| `/w/:slug/workflows`, `/webhooks`, `/audit` | Admin tools | Admin+ |
| `/w/:slug/reports` | Weekly reports | Member+ |
| `/w/:slug/billing` (+ `/billing/checkout`) | Plan, usage, upgrade; simulated checkout in mock mode | All roles (change: owner) |
| anything else | "Page not found", with a link back (to the workspace's projects inside `/w/:slug/`) | Everyone |

## Sign-in and errors

| Situation | What the user sees |
|---|---|
| Opens a link (e.g. a board) while signed out | Login page, then **straight back to that link** after signing in |
| Access token expires | Renewed silently; parallel requests share one refresh, because each refresh token works only once |
| Session can't be renewed (refresh token expired or revoked) | Tokens cleared, login page with "Your session has expired. Please sign in again." (`api.js` fires `SESSION_EXPIRED`, `AuthProvider` listens) |
| Server unreachable or down at start-up | "Can't reach the server…" or "temporarily unavailable" with **Try again**; you stay signed in. Only a rejected token signs you out |
| Proxy error page (nginx's HTML 502) | A readable message instead of a JSON parse crash |
| Workspace you don't belong to | "Workspace not found" (404). Other failures show the message and **Try again** |
| Submitting a form | The button is disabled and says "Signing in…" or "Creating…", so double clicks don't send twice |

The sign-in page shows the demo login (`owner@acme.test / demo12345`). It's baked in at build time and can be hidden for a public deployment with `VITE_DEMO_HINT=false` in `.env` (passed to the frontend image as a build argument).

## Accessibility

- **Dialogs** (`Modal.jsx`) are `role="dialog"` with `aria-modal` and a labelled title. Focus moves into the dialog when it opens, Tab and Shift+Tab stay inside it, Escape closes it, and focus returns to whatever opened it.
- **Notifications** are buttons, so they work with the keyboard; the bell announces the unread count ("Notifications, 2 unread"); Escape or a click outside closes the panel. Opening a notification marks it read.
- Visible focus ring on every control (`:focus-visible`), and correct `autocomplete` values so password managers fill the login and registration forms. Registration lists the password rules under the field.

## Polling

The bell asks for the unread count every 30 seconds, but **only while the browser tab is visible**. When you come back to the tab it checks at once, so background tabs no longer poll the server for nothing.

## How drag-and-drop works

1. The board loads in one request: `GET /boards/{id}/columns/` returns every status column with its ordered issues and the workflow's allowed transitions.
2. When a drag starts, columns the workflow forbids are dimmed and refuse drops.
3. On drop, the card moves on screen at once (optimistic update), then `POST /issues/{id}/move/ {status, index}` saves it.
4. If the server rejects the move, the board snaps back and a message explains why.

The library is `@hello-pangea/dnd`, a maintained fork of `react-beautiful-dnd`; it supports keyboard dragging too.

## Other design choices

- No global state library: React context holds the workspace, and each page fetches what it needs.
- Light and dark themes through CSS variables; layout works down to phone width (grids use `minmax(0, 1fr)` so long text can't push a card off screen).
- React Router's v7 behaviour is switched on already (`future` flags in `main.jsx`), so the upgrade won't change anything.
- Pages render only once the workspace in the URL has loaded, so a page never sends requests with the previous workspace's `X-Workspace` header.
- Viewers see everything read-only because edit controls are hidden by role. The API enforces the same rules, so hiding is only a convenience.
