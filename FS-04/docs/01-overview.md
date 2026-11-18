# 01 · Overview

[← Index](README.md) · [Next: Features and roles →](02-features-and-roles.md)

TaskFlow is a Jira-style project management product where every company gets its own isolated workspace with projects, Kanban boards, sprints and subscription billing.
All seven steps of the internship brief are implemented, tested and running in Docker. After the first build, every area was reviewed again day by day (Days 2–14) and its bugs fixed with regression tests; the [review log](13-challenges-and-next-steps.md#day-by-day-review-days-214) lists what changed.

## Problem

Teams need one place to plan and track work. A SaaS product has to serve many companies from a single deployment without any company seeing another's data, and it has to charge for usage.

## Tech stack

| Layer | Technology | Role |
|---|---|---|
| API | Node.js 24, Express 5, TypeScript (strict), Zod, `jose` (JWT) | REST endpoints, auth, role permissions, OpenAPI docs |
| Database | PostgreSQL 16 with Prisma 7 | Shared schema; every tenant row carries `workspaceId` |
| Background jobs | BullMQ + Redis 7 | Webhooks, emails, reminders, reports |
| Billing | Stripe Billing (test mode) or Stripe's official `stripe-mock` | Plans, checkout, signed webhooks |
| Frontend | React 18, TypeScript (strict), Vite 7, React Router, @hello-pangea/dnd | Single-page app with drag-and-drop board |
| Tests | Vitest (+ Supertest for the API, Testing Library for the UI) | 197 API tests on a real PostgreSQL, 62 UI tests |
| Infrastructure | Docker, Docker Compose, nginx, GitHub Actions | One-command stack; test → build → deploy pipeline |

## Scope delivered against the brief

| Brief step | Delivered | Details |
|---|---|---|
| 1. Tenant isolation + models | Shared schema with `workspace_id`; Workspace, Project, Board, Issue, Sprint and more | [04](04-multi-tenancy.md), [05](05-data-model.md) |
| 2. REST API + role permissions | 15 resources, 4 roles enforced per request | [06](06-api.md) |
| 3. Drag-and-drop Kanban | Optimistic drag-and-drop with server-side ordering and workflow rules | [07](07-frontend.md) |
| 4. Workflows, comments, attachments, audit log | Custom statuses and transitions; tenant-checked downloads; field-level audit diffs | [02](02-features-and-roles.md), [05](05-data-model.md) |
| 5. Webhooks + background jobs | HMAC-signed webhooks with retries; notifications; daily and weekly jobs (BullMQ, the Node.js counterpart of Celery) | [08](08-background-jobs.md) |
| 6. Stripe Billing + limits | Free / Pro / Business plans, HTTP 402 at limits, idempotent webhook sync | [09](09-billing.md) |
| 7. Docker + GitHub Actions | 7-service Compose stack; the pipeline tests (lint, type-check, 259 tests, coverage gate, Compose smoke test) and deploys (multi-arch images to GHCR, verified by running them, versioned GitHub Releases; optional server deploy) | [11](11-devops.md) |

In numbers: **197 backend tests at 96% line coverage**, **62 frontend tests**, the board answers in **11 SQL statements** whatever its size, and a smoke test walks through the whole running stack in CI.

**Version 2.0.0** rebuilt the backend in Node.js, Express, TypeScript and Prisma, and converted the frontend to TypeScript, when the brief's required tools changed (React, TypeScript, Node.js, Express, PostgreSQL, Prisma, Vitest, Docker). The API, features, demo and live site stayed the same; v1.0.1 (Django) remains tagged in Git. Brief steps 2 and 5 name Django REST Framework and Celery; they are met with their Node.js counterparts (Express with role permissions, BullMQ jobs). See [13 · Stack migration](13-challenges-and-next-steps.md#stack-migration-to-nodejs-and-typescript-v200).

## Deliverables checklist

| Deliverable | Where |
|---|---|
| Working demo | **Live: [taskflow-fs04.onrender.com](https://taskflow-fs04.onrender.com)** (demo logins in the README; [hosting](11-devops.md#live-deployment-free-always-on)); also runs locally with Docker ([14](14-setup.md)); demo video script in the [presentation outline](guides/PRESENTATION_OUTLINE.md) |
| GitHub repo with clean commits, README, setup | Repository root `README.md`; [commit plan](guides/COMMIT_PLAN.md) |
| Architecture diagram + data/API docs | [03](03-architecture.md), [05](05-data-model.md), [06](06-api.md), [`openapi.yaml`](openapi.yaml) |
| Test results + performance numbers | [12](12-testing.md) |
| 10-minute presentation | [Presentation outline](guides/PRESENTATION_OUTLINE.md) |
| Individual reflection | [Reflection template](guides/REFLECTION_TEMPLATE.md) |
