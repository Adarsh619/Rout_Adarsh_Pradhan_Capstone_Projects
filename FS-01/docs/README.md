# ShopSphere Documentation

ShopSphere is a multi-vendor marketplace: many vendors sell, customers buy from several of them in one checkout, and the platform splits each payment and keeps a commission.
Read the files in order, or jump to the topic you need. Topics without a link are written on the day that feature is built.

## Design documentation

| # | File | What it covers | Status |
|---|---|---|---|
| 01 | [Overview](01-overview.md) | Problem, tech stack, scope against the brief | ✓ |
| 02 | [Features and roles](02-features-and-roles.md) | What customers, vendors and admins can do | ✓ |
| 03 | [System architecture](03-architecture.md) | Components, request flow, diagram, local vs live | ✓ |
| 04 | [Design decisions](04-design-decisions.md) | Razorpay + own split engine (and why not Route), sub-orders, escrow, paise, Elasticsearch sync, S3 uploads | ✓ |
| 05 | [Data model](05-data-model.md) | Collections, relationships, ER diagram, money rules | ✓ |
| 06 | API reference | Endpoints, auth, errors | Day 3 |
| 07 | Frontend | React structure, pages, state | Day 8 |
| 08 | Background jobs | BullMQ queues, retries, schedules | Day 4 |
| 09 | Payments | Razorpay checkout and webhooks, split and escrow ledger, payouts, mock mode | Day 6 |
| 10 | Security | Auth, sessions, roles, validation, uploads | Day 2 |
| 11 | DevOps | Docker Compose, CI/CD, live hosting | Day 9 |
| 12 | Testing and performance | Test counts, coverage, load-test numbers | Day 9 |
| 13 | Challenges and next steps | Problems solved, known limits, future work | Day 10 |
| 14 | Setup | Run it locally, folder layout | Day 10 |

## Product and technical specs

| File | What it covers |
|---|---|
| [Product Requirements (PRD)](specs/01-prd.md) | Problem, goals, personas, user stories, functional and non-functional requirements |
| [App flow](specs/02-app-flow.md) | Screen map, vendor onboarding, buying journey, sub-order lifecycle, access by role |
| [Database schema](specs/03-database-schema.md) | Every collection, field, index and money rule; what lives in Redis |
| [API list](specs/04-api-list.md) | Every endpoint with its role and the day it's built |

## Guides

| File | Use |
|---|---|
| [10-day build tracker](guides/DAY_PLAN.md) | Day-by-day checklist |

## Other files

- [`assets/`](assets): architecture and ER diagrams (PNG + Mermaid source)
