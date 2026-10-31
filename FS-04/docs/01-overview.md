# 01 · Overview

[← Index](README.md) · [Next: Features and roles →](02-features-and-roles.md)

TaskFlow is a Jira-style project management product where every company gets its own isolated workspace with projects, Kanban boards, sprints and subscription billing.
All seven steps of the internship brief are implemented, tested and running in Docker. After the first build, every area was reviewed again day by day (Days 2–14) and its bugs fixed with regression tests; the [review log](13-challenges-and-next-steps.md#day-by-day-review-days-214) lists what changed.

## Problem

Teams need one place to plan and track work. A SaaS product has to serve many companies from a single deployment without any company seeing another's data, and it has to charge for usage.

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| API | Django 5.2, Django REST Framework, SimpleJWT, drf-spectacular | REST endpoints, auth, role permissions, OpenAPI docs |
| Database | PostgreSQL 16 | Shared schema; every tenant row carries `workspace_id` |
| Background jobs | Celery 5 + Redis 7 | Webhooks, emails, reminders, reports |
| Billing | Stripe Billing (test mode) or Stripe's official `stripe-mock` | Plans, checkout, signed webhooks |
| Frontend | React 18, Vite, React Router, @hello-pangea/dnd | Single-page app with drag-and-drop board |
| Infrastructure | Docker Compose, nginx, GitHub Actions | One-command stack; test → build → deploy pipeline |

## Scope delivered against the brief

| Brief step | Delivered | Details |
|---|---|---|
| 1. Tenant isolation + models | Shared schema with `workspace_id`; Workspace, Project, Board, Issue, Sprint and more | [04](04-multi-tenancy.md), [05](05-data-model.md) |
| 2. REST API + role permissions | 15 resources, 4 roles enforced per request | [06](06-api.md) |
| 3. Drag-and-drop Kanban | Optimistic drag-and-drop with server-side ordering and workflow rules | [07](07-frontend.md) |
| 4. Workflows, comments, attachments, audit log | Custom statuses and transitions; tenant-checked downloads; field-level audit diffs | [02](02-features-and-roles.md), [05](05-data-model.md) |
| 5. Webhooks + Celery jobs | HMAC-signed webhooks with retries; notifications; daily and weekly jobs | [08](08-background-jobs.md) |
| 6. Stripe Billing + limits | Free / Pro / Business plans, HTTP 402 at limits, idempotent webhook sync | [09](09-billing.md) |
| 7. Docker + GitHub Actions | 7-service Compose stack; the pipeline tests (lint, 237 tests, coverage gate, Compose smoke test) and deploys (multi-arch images to GHCR, verified by running them, versioned GitHub Releases; optional server deploy) | [11](11-devops.md) |

In numbers: **176 backend tests at 96% coverage**, **61 frontend tests**, the board answers in **7 SQL queries** whatever its size, and CI is green on `main`.

## Deliverables checklist

| Deliverable | Where |
|---|---|
| Working demo | Run locally with Docker ([14](14-setup.md)); record the screen for the demo video (script in the [presentation outline](guides/PRESENTATION_OUTLINE.md)) |
| GitHub repo with clean commits, README, setup | Repository root `README.md`; [commit plan](guides/COMMIT_PLAN.md) |
| Architecture diagram + data/API docs | [03](03-architecture.md), [05](05-data-model.md), [06](06-api.md), [`openapi.yaml`](openapi.yaml) |
| Test results + performance numbers | [12](12-testing.md) |
| 10-minute presentation | [Presentation outline](guides/PRESENTATION_OUTLINE.md) |
| Individual reflection | [Reflection template](guides/REFLECTION_TEMPLATE.md) |
