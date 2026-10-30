# Product Requirements Document (PRD) · TaskFlow

[Index](../README.md) · [Next: Technical Requirements →](02-trd.md)

| | |
|---|---|
| Product | TaskFlow: multi-tenant SaaS project management platform |
| Project ID | FS-04 (Nexvia full-stack internship) |
| Author | Rout Adarsh Pradhan |
| Status | v1.0 built; demo, presentation and reflection pending |
| Last updated | 25 Oct 2026 |

## 1. Problem

Software teams need one place to plan, track and ship work. Existing tools are either single-team (no isolation between customers) or expensive enterprise products.
A SaaS vendor wants to serve **many companies from one deployment**, keep each company's data **strictly separate**, and **charge** per plan.

## 2. Goals and non-goals

| Goals | Non-goals (v1) |
|---|---|
| Each company gets an isolated workspace with its own members, projects and data | Real-time collaboration (live cursors, WebSocket board sync) |
| Teams plan work in projects, boards and sprints, and move issues by drag-and-drop | Native mobile apps |
| Admins tailor workflows (statuses and allowed transitions) | Time tracking, roadmaps / Gantt charts |
| Every change is traceable (audit log) and can notify other systems (webhooks) | Email invitations for people without an account |
| Companies subscribe to paid plans that lift usage limits | Live payments (test mode / mock only) |
| The product runs with one command and ships through CI/CD | Multi-region hosting, SSO / SAML |

## 3. Users and personas

| Persona | Role in workspace | Needs |
|---|---|---|
| **Olivia, founder** | Owner | Create the company workspace, invite people, choose and pay for a plan |
| **Arjun, engineering manager** | Admin | Set up projects, workflows and sprints; see the audit log and reports; connect webhooks to other tools |
| **Meera, developer** | Member | See her assigned work, move cards, comment, attach files, get notified |
| **Sam, stakeholder** | Viewer | Follow progress without being able to change anything |

## 4. User stories and acceptance criteria

| ID | As a… | I want to… | Acceptance criteria |
|---|---|---|---|
| US-01 | visitor | sign up and create my company workspace | Account + workspace + owner role created in one step; I land on the workspace |
| US-02 | owner/admin | add a colleague by email with a role | Existing user added with viewer/member/admin; duplicates rejected; owner can't be changed or removed |
| US-03 | admin | create a project with a short key | Key unique in the workspace; a board is created automatically; issues are numbered `KEY-1, KEY-2…` |
| US-04 | member | create an issue with type, priority, assignee, points, due date | Issue appears in the first status column; assignee is notified |
| US-05 | member | drag an issue to another column or position | Order is saved; moves the workflow forbids are blocked with a message and the card snaps back |
| US-06 | admin | define custom statuses and allowed transitions | New statuses become board columns; transitions are enforced by the API |
| US-07 | admin | plan, start and complete sprints | One active sprint per project; completing returns unfinished issues to the backlog |
| US-08 | member | comment on and attach files to an issue | Comments notify reporter and assignee; files ≤ 10 MB; downloads only for workspace members |
| US-09 | admin | see who changed what | Audit log lists actor, action, entity, old → new values; per-issue history tab |
| US-10 | admin | send events to other systems | Webhook per URL with event filter; signed payloads; retries; delivery log; test ping |
| US-11 | member | be told about work that concerns me | In-app notifications + email for assignment, comments, moves, due tomorrow |
| US-12 | admin | get a weekly summary | Report every Monday and on demand: created, completed, open, overdue, open per assignee |
| US-13 | owner | upgrade to a paid plan | Checkout → plan changes after the payment webhook; limits rise immediately |
| US-14 | owner | change plan or cancel | Portal / manage page; cancellation returns the workspace to Free limits |
| US-15 | any user | never see another company's data | Requests for another workspace's data return 404; guessed IDs rejected |

## 5. Functional requirements

| ID | Requirement | Priority |
|---|---|---|
| FR-01 | Email + password registration and login with JWT | Must |
| FR-02 | Workspaces with unique slugs; a user may belong to several | Must |
| FR-03 | Four roles (owner, admin, member, viewer) enforced on every API action | Must |
| FR-04 | Projects, boards (Kanban / Scrum), sprints, issues with per-project numbering | Must |
| FR-05 | Drag-and-drop Kanban board with persistent ordering | Must |
| FR-06 | Custom workflows: statuses with categories, colours, order; allowed transitions | Must |
| FR-07 | Comments and file attachments on issues | Must |
| FR-08 | Append-only audit log with field-level changes | Must |
| FR-09 | Outgoing webhooks: event subscription, HMAC signature, retries, delivery log | Must |
| FR-10 | Background jobs: notification emails, due-date reminders, weekly reports | Must |
| FR-11 | Subscription plans with usage limits; Stripe Billing checkout, portal and webhooks (test mode) | Must |
| FR-12 | Board filters (sprint, assignee, text search) and project statistics | Should |
| FR-13 | In-app notification centre with unread count | Should |
| FR-14 | Demo data seeding with Faker | Should |
| FR-15 | Stripe mock mode for environments without a Stripe account | Should |

## 6. Plans and limits

| Plan | Price | Projects | Members | Issues |
|---|---|---|---|---|
| Free | $0 | 2 | 5 | 200 |
| Pro | $10 / month | 20 | 50 | 10,000 |
| Business | $25 / month | Unlimited | Unlimited | Unlimited |

Hitting a limit shows an "upgrade" message (HTTP 402). Past-due or cancelled subscriptions fall back to Free limits.

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Isolation | Zero cross-tenant data access, proven by automated tests |
| Performance | Board with 60 issues loads in < 100 ms server time with a constant number of queries |
| Reliability | Webhooks retried with backoff; no webhook for rolled-back changes; Stripe events processed once |
| Security | Role checks on every endpoint; signed webhooks both ways; secrets only in `.env` |
| Usability | Works in light and dark mode and at phone width; read-only UI for viewers |
| Operability | One command to run (`docker compose up`); CI runs lint + tests on every push |
| Cost | Runs entirely on free tiers |

## 8. Success metrics (for the internship review)

| Metric | Target | Result |
|---|---|---|
| Brief steps implemented | 7 / 7 | 7 / 7 |
| Automated backend tests passing | All | 176 / 176 (plus 57 frontend tests) |
| Backend line coverage | ≥ 80% | 96% (CI fails below 90%) |
| Cross-tenant leaks found in tests | 0 | 0 |
| CI pipeline | Green on main | Green |

## 9. Assumptions, constraints and risks

| Item | Detail | Mitigation |
|---|---|---|
| Stripe access | New Stripe accounts in India are invite-only | Mock mode on Stripe's official `stripe-mock`; real keys switch it to live test mode |
| Hosting cost | Must stay free | Local Docker demo + screen recording; optional free-tier hosting |
| Timeline | 14 days | Phased plan (see [Implementation plan](04-implementation-plan.md)) |
| Single developer | One intern | Small, well-tested modules; CI catches regressions |

## 10. Release criteria (v1.0)

- All "Must" requirements done and covered by tests
- CI green on `main`
- Documentation complete (`docs/`)
- Demo recorded; presentation and reflection written
