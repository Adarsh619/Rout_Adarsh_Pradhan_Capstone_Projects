# TaskFlow Documentation

TaskFlow is a multi-tenant, Jira-style project management SaaS: every company gets an isolated workspace with projects, drag-and-drop Kanban boards, sprints and subscription billing.
Read the files in order, or jump to the topic you need.

## Design documentation

| # | File | What it covers |
|---|---|---|
| 01 | [Overview](01-overview.md) | Problem, tech stack, scope delivered against the brief |
| 02 | [Features and roles](02-features-and-roles.md) | What users can do; the four workspace roles |
| 03 | [System architecture](03-architecture.md) | Components, how a request flows, diagram |
| 04 | [Multi-tenancy](04-multi-tenancy.md) | Isolation strategy, trade-offs, how it is enforced |
| 05 | [Data model](05-data-model.md) | All 19 models, relationships, ER diagram |
| 06 | [API reference](06-api.md) | Auth, tenant header, endpoints, errors, webhook format |
| 07 | [Frontend](07-frontend.md) | React structure, sign-in and errors, accessibility, board, issue window, admin pages |
| 08 | [Background jobs](08-background-jobs.md) | Celery tasks, schedules, retries |
| 09 | [Billing](09-billing.md) | Plans and limits, Stripe flow, mock mode |
| 10 | [Security](10-security.md) | Authentication, sessions, authorisation, signatures, SSRF, client IPs, attachments |
| 11 | [DevOps](11-devops.md) | Docker Compose services, images, nginx, CI/CD pipeline with smoke test |
| 12 | [Testing and performance](12-testing.md) | 176 backend + 61 frontend tests, coverage, performance numbers, bugs found |
| 13 | [Challenges and next steps](13-challenges-and-next-steps.md) | Key decisions, problems solved, day-by-day review log, known limits, future work |
| 14 | [Setup and repository layout](14-setup.md) | Run it locally, folder structure |

## Product and technical specs

| File | What it covers |
|---|---|
| [Product Requirements (PRD)](specs/01-prd.md) | Problem, goals, personas, user stories, functional and non-functional requirements, plans |
| [Technical Requirements (TRD)](specs/02-trd.md) | Stack and versions, tenancy, API standards, data, jobs, billing, performance targets, testing, CI/CD |
| [App flow](specs/03-app-flow.md) | Screen map, onboarding, issue lifecycle, drag-and-drop, sprints, upgrade and limit flows, role access |
| [Implementation plan](specs/04-implementation-plan.md) | 14-day phases, milestones, work breakdown, risks, definition of done |
| [UI/UX design brief](specs/05-ui-ux-design-brief.md) | Principles, information architecture, screens, colour tokens, components, accessibility |
| [Backend schema](specs/06-backend-schema.md) | Every table, column, type, constraint and index; ER diagram; delete behaviour |

## Guides

| File | Use |
|---|---|
| [Accounts and setup checklist](guides/ACCOUNTS_SETUP.md) | Free accounts and tools; Stripe mock vs real test mode |
| [14-day commit plan](guides/COMMIT_PLAN.md) | Which files to commit each day |
| [Presentation outline](guides/PRESENTATION_OUTLINE.md) | 10-minute final presentation |
| [Reflection template](guides/REFLECTION_TEMPLATE.md) | Individual reflection |

## Other files

- [`openapi.yaml`](openapi.yaml): machine-readable API schema (live Swagger UI at `http://localhost:8000/api/docs/`)
- [`assets/`](assets): architecture and ER diagrams (PNG + Mermaid source) and app screenshots
