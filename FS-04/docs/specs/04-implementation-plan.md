# Implementation plan · TaskFlow

[← App flow](03-app-flow.md) · [Index](../README.md) · [Next: UI/UX design brief →](05-ui-ux-design-brief.md)

A 14-day plan following the brief's seven steps, with milestones, deliverables and status. The code was built first and is now committed; the remaining work is the demo, presentation and reflection.

## Phases

| Phase | Days | Brief step | Scope | Exit criteria | Status |
|---|---|---|---|---|---|
| 0. Setup | 1 | – | Repo, tooling (ruff, ESLint, pytest), VS Code config, `.env` | Project runs; lint passes | ✅ Done |
| 1. Tenancy + models | 2–4 | 1 | User, Workspace, Membership, roles; Workflow, Project, Board, Sprint, Issue models | Migrations apply; isolation design reviewed | ✅ Done |
| 2. REST API + permissions | 4–5 | 2 | Viewsets, serializers, role permissions, tenant scoping, OpenAPI | Isolation + role tests pass | ✅ Done |
| 3. Workflows, comments, attachments, audit | 5–6 | 4 | Custom statuses/transitions, comments, uploads, audit log | Transition enforcement + audit diff tests pass | ✅ Done |
| 4. Tests + seed data | 7 | – | pytest suites, Faker `seed_demo` | ≥ 80% coverage | ✅ Done (94%) |
| 5. Celery, webhooks, notifications | 8 | 5 | Signed webhooks with retries, emails, reminders, weekly reports | Webhook signature + retry tests pass | ✅ Done |
| 6. Stripe Billing | 9 | 6 | Plans + limits, checkout, portal, webhooks, mock mode | Upgrade → limits lift; idempotent webhooks | ✅ Done |
| 7. React foundation | 10 | 3 | Vite app, auth, API client, layout, workspace switcher | Login → workspace works | ✅ Done |
| 8. Kanban board | 11 | 3 | Drag-and-drop board, issue modal, sprints page | Move persists after reload | ✅ Done |
| 9. Admin pages | 12 | 3–6 | Members, workflows, webhooks, audit, reports, billing | All pages usable by role | ✅ Done |
| 10. Docker + CI/CD | 13 | 7 | Compose stack, Dockerfiles, GitHub Actions | `docker compose up` works; CI green | ✅ Done |
| 11. Docs | 14 | – | README, docs/ 01–14, specs | Docs reviewed | ✅ Done |
| 12. Demo, presentation, reflection | Before deadline | – | Screen recording, 10-min deck, reflection | Deliverables ready for the Drive folder | ⏳ To do |

## Milestones

| Milestone | Definition | Status |
|---|---|---|
| M1: Backend core | Tenancy, API, roles, workflows, audit with tests | ✅ |
| M2: Integrations | Celery jobs, webhooks, Stripe billing | ✅ |
| M3: Usable product | React app with drag-and-drop board, all pages | ✅ |
| M4: Shippable | Docker + CI green on GitHub | ✅ |
| M5: Submission | Demo video, presentation, reflection, documentation | ⏳ |

## Work breakdown by component

| Component | Main files | Tests |
|---|---|---|
| Accounts | `backend/apps/accounts` | `test_auth_and_tenancy.py` |
| Tenancy | `backend/apps/tenancy` | `test_auth_and_tenancy.py` |
| Tracker | `backend/apps/tracker` | `test_issues_and_workflows.py`, `test_seed_and_perf.py` |
| Audit | `backend/apps/audit` | `test_issues_and_workflows.py` |
| Integrations | `backend/apps/integrations` | `test_integrations.py` |
| Billing | `backend/apps/billing` | `test_billing.py` |
| Frontend | `frontend/src` | `frontend/src/test` |
| Infra | `docker-compose.yml`, Dockerfiles, `.github/workflows/fs04-ci.yml` | CI pipeline |

## Risks and mitigations

| Risk | Impact | Mitigation | Outcome |
|---|---|---|---|
| Cross-tenant data leak | Critical | One central mixin + tenant-aware FK fields + dedicated tests | No leaks in tests |
| Card order corrupted by concurrent moves | Medium | Row locks + re-ranking in one transaction | Covered by tests |
| Stripe unavailable in India | High for step 6 | Mock mode on official `stripe-mock`, real keys optional | Billing fully demonstrable |
| Docker unfamiliar on Windows | Medium | WSL 2 setup guide; local run documented | Running on the laptop |
| Hosting costs | Medium | Free tiers only; screen-recorded demo | Zero cost |
| Time (14 days) | High | Build first, test continuously, CI from day 1 | Ahead of schedule |

## Definition of done (per feature)

1. Code merged on `main` and lint-clean
2. Automated tests cover the main path and the main failure path
3. Role and tenant rules verified
4. Documented in `docs/`
5. CI green
