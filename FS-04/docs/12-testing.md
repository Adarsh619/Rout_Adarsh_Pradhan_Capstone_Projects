# 12 · Testing and performance

[← DevOps](11-devops.md) · [Index](README.md) · [Next: Challenges and next steps →](13-challenges-and-next-steps.md)

Recorded 25 Oct 2026 on PostgreSQL 16, Python 3.13, Node 22. CI runs the same suites on every push.

## Backend: pytest (49 tests, 94% line coverage)

```
cd backend && pytest
49 passed in ~20s
TOTAL  1533 statements  93 missed  94% coverage
```

| Suite | What it proves |
|---|---|
| `test_auth_and_tenancy.py` | Register/login; owner can delete a workspace with data (admins can't); 401 without a token; `X-Workspace` required; **a user in tenant B can't list, read, reference or impersonate tenant A** (404); you can't assign non-members; role matrix (viewer/member/admin) for issues, projects and the audit log; member management rules (the owner is protected) |
| `test_issues_and_workflows.py` | Project creates its board and default workflow; unique keys; `WEB-1..N` numbering; drag-and-drop move re-ordering; **workflow transitions enforced**; custom workflow (free movement until rules are added); statuses from another workflow rejected; audit diffs + issue history; comments + notifications + author-only edits; attachments upload and **tenant-checked download**; sprint lifecycle (one active, carry-over to backlog); board sprint filters; project stats |
| `test_integrations.py` | Webhook payload **HMAC signature** correct; event filtering; failure triggers a Celery retry; webhooks admin-only; weekly report generated + emailed; due-date reminders |
| `test_billing.py` | Free plan limit → **402**; upgraded plan lifts limits; past-due falls back to Free; Checkout session created with the right price; owner-only checkout; webhooks signed exactly like Stripe signs them: plan sync is **idempotent**, cancellation downgrades, payment failure → past-due, bad or wrong-secret signature → 400; **mock mode**: subscribe → change → cancel through signed webhooks, owner-only, disabled outside mock mode; **integration test against the real `stripe-mock` server** (CI service container) |
| `test_seed_and_perf.py` | Faker seed creates two isolated tenants and `--reset` works; **board endpoint query count stays constant** |

## Frontend: Vitest + Testing Library (6 tests)

```
cd frontend && npm test
Test Files 3 passed · Tests 6 passed
```
`boardLogic.test.js` (transition rules, optimistic card move without mutating input), `IssueCard.test.jsx` (rendering + click), `api.test.js` (DRF error formatting).

## End-to-end smoke test (Playwright, manual run)
Logged in as `owner@acme.test` → opened the WEB board → dragged a card from *To Do* to *In Progress* with the keyboard → reloaded and confirmed the move
persisted → opened the issue modal → visited billing, workflows, audit, members, webhooks and reports. **0 console errors.** Screenshots are in [`assets/screenshots/`](assets/screenshots).

## Performance

| Measurement | Result |
|---|---|
| `GET /boards/{id}/columns/` with 60 issues | **7 SQL queries**, ~43 ms (Django test client, local Postgres). Query count doesn't grow with issue count (select_related + comment-count annotation). |
| Production JS bundle | 307 kB (96 kB gzipped) |

How to reproduce the perf number: `pytest tests/test_seed_and_perf.py -s --no-cov`.

## Bugs found by testing

| Bug | How it was found | Fix |
|---|---|---|
| The Stripe webhook handler called `.get()` on Stripe event objects. With `stripe>=8` those aren't dicts, so **real** Stripe events would have crashed it. | The first tests replaced `construct_event` with plain dicts, which hid it. Testing against `stripe-mock` and signing real payloads exposed it. | Verify the signature, then parse the raw JSON payload. Tests now sign payloads exactly like Stripe instead of mocking verification. |
| Deleting a workspace (API or `seed_demo --reset`) failed with `ProtectedError`. Projects PROTECT their workflow and issues PROTECT their status. | Re-seeding during the end-to-end test. | `delete_workspace()` removes issues and projects first, inside one transaction. Regression tests added. |
| After cancelling, the Free plan still showed a renewal date. | End-to-end browser run of mock billing. | Clear `current_period_end` when a subscription is canceled. |

## Mock billing end to end (Playwright)
Free → **Upgrade** (simulated checkout) → **Subscribe** → Pro (sidebar badge updates) → **Manage** → Business → **Cancel** → Free. 0 console errors.
