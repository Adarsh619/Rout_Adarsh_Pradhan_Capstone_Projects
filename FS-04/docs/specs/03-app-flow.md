# App flow · TaskFlow

[← Technical Requirements](02-trd.md) · [Index](../README.md) · [Next: Implementation plan →](04-implementation-plan.md)

How users move through the app, and what happens behind each key action. The diagrams render on GitHub.

## 1. Screen map

```mermaid
flowchart TD
  L[Login] --> WS[Workspace picker]
  R[Register<br/>account + first workspace] --> P
  WS -->|pick or create| P[Projects]
  P --> B[Kanban board]
  P --> S[Backlog and sprints]
  B <--> S
  B --> IM[Issue modal<br/>details · comments · attachments · history]
  S --> IM
  P --> M[Members]
  P --> RP[Reports]
  P --> WF[Workflows · admin]
  P --> WH[Webhooks · admin]
  P --> AU[Audit log · admin]
  P --> BL[Billing]
  BL --> CO[Checkout<br/>Stripe hosted, or simulated in mock mode]
  CO --> BL
  N[Notifications bell<br/>on every workspace page] --> B
```

## 2. Onboarding

```mermaid
flowchart LR
  A[Visitor opens /register] --> B[Enters name, email, password,<br/>company name]
  B --> C{Valid?}
  C -->|no| B
  C -->|yes| D[API creates User, Workspace,<br/>Owner membership, default workflow,<br/>Free subscription]
  D --> E[Returns JWT tokens + workspace slug]
  E --> F[App opens /w/slug: Projects]
  F --> G[Owner creates a project<br/>board is created automatically]
  G --> H[Owner adds colleagues by email with roles]
```

## 3. Daily work: issue lifecycle

```mermaid
stateDiagram-v2
  [*] --> ToDo: issue created (WEB-n)
  ToDo --> InProgress
  InProgress --> ToDo
  InProgress --> InReview
  InReview --> InProgress
  InReview --> Done
  Done --> InReview
  Done --> ToDo: reopen
  Done --> [*]
```

These are the default workflow's transitions. Admins can define their own on the Workflows page; with no transitions defined, any move is allowed.

## 4. Drag-and-drop a card

```mermaid
sequenceDiagram
  actor U as Member
  participant UI as React board
  participant API as Django API
  participant DB as PostgreSQL
  participant Q as Redis / Celery
  U->>UI: start dragging a card
  UI->>UI: dim columns the workflow forbids
  U->>UI: drop in "In Progress", position 2
  UI->>UI: move card on screen (optimistic)
  UI->>API: POST /issues/42/move/ {status, index: 2}
  API->>API: check role ≥ member and transition allowed
  API->>DB: lock column, re-rank cards, save status
  API->>DB: write AuditLog "issue.moved"
  API-->>UI: 200 updated issue
  DB-->>Q: after commit: webhook + notification jobs
  Q-->>Q: send signed webhooks, email assignee/reporter
  alt move not allowed
    API-->>UI: 400 "Transition not allowed"
    UI->>UI: snap card back, show message
  end
```

## 5. Sprint cycle

```mermaid
flowchart LR
  A[Admin creates sprint<br/>planned] --> B[Members assign backlog<br/>issues to the sprint]
  B --> C[Admin starts sprint<br/>only one active per project]
  C --> D[Team works on the board<br/>filter: active sprint]
  D --> E[Admin completes sprint]
  E --> F[Done issues stay in the sprint<br/>unfinished ones return to backlog]
  F --> A
```

## 6. Upgrade a plan

```mermaid
sequenceDiagram
  actor O as Owner
  participant UI as React app
  participant API as Django API
  participant S as Stripe or stripe-mock
  O->>UI: Billing → Upgrade to Pro
  UI->>API: POST /billing/checkout/ {plan: pro}
  API->>S: create Customer + Checkout Session
  API-->>UI: checkout URL
  UI->>O: Stripe Checkout (or simulated page in mock mode)
  O->>S: pay with test card / confirm
  S->>API: signed webhooks: checkout.session.completed, customer.subscription.created
  API->>API: verify signature, skip duplicates, set plan = pro
  UI->>API: GET /billing/
  API-->>UI: plan Pro, new limits
```

## 7. Hitting a plan limit

```mermaid
flowchart LR
  A[Admin clicks Create project] --> B{Projects used < plan limit?}
  B -->|yes| C[Project + board created]
  B -->|no| D[API returns 402<br/>Free plan allows 2 projects]
  D --> E[UI shows message with link to Billing]
```

## 8. Role-based access at a glance

| Screen / action | Viewer | Member | Admin | Owner |
|---|---|---|---|---|
| View projects, board, issues, members, billing | ✅ | ✅ | ✅ | ✅ |
| Create / edit issues, drag cards, comment, attach | | ✅ | ✅ | ✅ |
| Reports | | ✅ (view) | ✅ (+ generate) | ✅ |
| Projects, sprints, workflows, members, webhooks, audit log | | | ✅ | ✅ |
| Upgrade / manage plan, delete workspace | | | | ✅ |
