# 12 · Testing and performance

[← DevOps](11-devops.md) · [Index](README.md) · [Next: Challenges and next steps →](13-challenges-and-next-steps.md)

Recorded 29 Oct 2026 on PostgreSQL 16 (Docker), Python 3.14 locally and 3.12 in CI, Node 24 locally and 22 in CI. CI runs the same suites on every push, and has passed on every commit pushed so far.

## Backend: pytest (173 tests, 96% line coverage)

```
cd backend && pytest
173 passed in ~45 s
TOTAL  2230 statements  79 missed  96% coverage
```

The suite used to take about 3.5 minutes. Tests now use Django's fast MD5 password hasher (real hashing is deliberately slow and every test creates users), and the seed tests create fewer issues where the count doesn't matter. Production hashing is unchanged. CI fails if coverage drops below 90%.
Shared API helpers (`new_issue`, `move`, `new_sprint`) are fixtures in `tests/conftest.py`. Tests never use real DNS: an autouse fixture resolves every webhook host to a public documentation address unless a test says otherwise.

| Suite | What it proves |
|---|---|
| `test_auth_and_tenancy.py` | Register/login; owner can delete a workspace with data (admins can't); 401 without a token; `X-Workspace` required; **a user in tenant B can't list, read, reference or impersonate tenant A** (404); you can't assign non-members; role matrix (viewer/member/admin) for issues, projects and the audit log; member management rules (the owner is protected) |
| `test_issues_and_workflows.py` | Project creates its board and default workflow; unique keys; `WEB-1..N` numbering; drag-and-drop move re-ordering; **workflow transitions enforced**; custom workflow (free movement until rules are added); statuses from another workflow rejected; audit diffs + issue history; comments + notifications + author-only edits; attachments upload and **tenant-checked download**; sprint lifecycle (one active, carry-over to backlog); board sprint filters; project stats |
| `test_integrations.py` | Webhook payload **HMAC signature** correct; event filtering; failure triggers a Celery retry; webhooks admin-only; weekly report generated + emailed; due-date reminders |
| `test_billing.py` | Free plan limit → **402**; upgraded plan lifts limits; past-due falls back to Free; Checkout session created with the right price; owner-only checkout; webhooks signed exactly like Stripe signs them: plan sync is **idempotent**, cancellation downgrades, payment failure → past-due, bad or wrong-secret signature → 400; **mock mode**: subscribe → change → cancel through signed webhooks, owner-only, disabled outside mock mode; **integration test against the real `stripe-mock` server** (CI service container) |
| `test_seed_and_perf.py` | Faker seed creates two isolated tenants and `--reset` works; it refuses to run with `DEBUG=false`; every seeded row passes the model rules (`full_clean()`), viewers never report, comment or get assigned, open issues never sit in a closed sprint; the seed includes a full audit trail, notifications, a closed sprint and a report; **the board uses the same number of queries for 20 and 60 issues, and no more than 7** |
| `test_accounts.py` | Login ignores email case; weak passwords rejected (short, common, numeric, like the email); `/me` can't change the email; **refresh tokens rotate and the old one stops working**; logout and password change revoke tokens; **login is rate-limited**; Django admin's add-user form asks for an email |
| `test_tenancy.py` | **Removed or departed members get no more notifications** and their open issues are unassigned; only the owner manages admins; the tenant comes from the header only; leaving; **ownership transfer**; duplicate workspace slugs retried; workspace renames audited; workspace list query count constant; admin keeps one owner |
| `test_tracker_models.py` | **Database rules**: one active sprint, one default workflow, sprint end after start; hex colours and ASCII project keys; **attachment files deleted after commit** (also on cascade, kept on rollback); `clean()` rejects cross-tenant links; Django admin numbers issues and lists them in a constant number of queries |
| `test_issues_api.py` | A status change in the issue form **moves the card like a drag** (bottom of column, `issue.moved`, notification); parents fixed after creation; no issues in closed sprints; priority sorts by severity; bad board filters → 400; moves re-check the workflow against the locked, current status; a workflow keeps one status |
| `test_issue_deletion.py` | **Only the reporter or an admin can delete an issue**; `can_delete` per caller (detail and board); "ask an admin" notifies admins and the owner by bell and email, once per unread request |
| `test_audit.py` | **Spoofed `X-Forwarded-For` can't fake the audit IP or dodge the login limit**; entries can't be edited or deleted (model, bulk, admin), but go with their workspace; the actor's email survives account deletion; filters by kind, person, search and date; paging; IPs hidden from the issue History tab; **CSV export** respects filters, neutralises formulas and is admin-only |
| `test_webhooks.py` | **Internal URLs refused** (localhost, private ranges, cloud metadata, Docker service names), at save time and again before delivery when DNS points inside; redirects not followed; **retry policy** (5xx/408/429/network/DNS failure yes, 4xx and private addresses no, stop at 5 attempts); **the event list matches exactly what the app sends**; secret rotation (audited without the secret, new deliveries signed with it); webhook edits and deletes audited; failed deliveries show the response and can be redelivered; old delivery logs cleaned up; due-date reminders once a day |
| `test_billing_events.py` | **A late "deleted" for an old subscription can't downgrade a paying workspace**; older events arriving late are ignored; checkout events never replace a different subscription; payment failures only count for the current subscription; **a failure while applying an event rolls back, and Stripe's retry is applied**; checkout refused while subscribed (no double billing); Stripe-driven plan and status changes audited; plan limits checked under a row lock, and only inside a transaction; billing endpoints fully described in the API schema; Stripe links and the event log read-only in Django admin |

## Frontend: Vitest + Testing Library (19 tests)

```
cd frontend && npm test
Test Files 6 passed · Tests 19 passed
```
`boardLogic.test.js` (transition rules, optimistic card move without mutating input), `IssueCard.test.jsx` (rendering + click), `api.test.js` (DRF error formatting), `billingMessages.test.js` (the right message after mock subscribe, change and cancel), `DeleteIssueControls.test.jsx` (Delete vs. the "ask an admin" explanation, request sent, retry on failure), `auditFormat.test.js` (readable audit changes and badge colours).

## End-to-end smoke test (Playwright, manual run)
Logged in as `owner@acme.test` → opened the WEB board → dragged a card from *To Do* to *In Progress* with the keyboard → reloaded and confirmed the move
persisted → opened the issue modal → visited billing, workflows, audit, members, webhooks and reports. **0 console errors.** Screenshots are in [`assets/screenshots/`](assets/screenshots).

## Performance

| Measurement | Result |
|---|---|
| `GET /boards/{id}/columns/` with 60 issues | **7 SQL queries**, ~48 ms median once warm (Django test client inside the backend container, Docker Postgres). The first request in a fresh process takes ~200–600 ms while Python loads code. Query count doesn't grow with issue count (select_related + comment-count annotation). |
| `GET /workspaces/` | Constant query count however many workspaces and members (only your own membership is loaded) |
| Django admin issue list | Constant query count however many issues |
| Production JS bundle | 316 kB (99 kB gzipped) |

The query count is an **assertion**, not just a printout: `test_board_query_count_does_not_grow_with_issues` fails if the board needs more than 7 queries, or more for 60 issues than for 20. To see the numbers: `pytest tests/test_seed_and_perf.py -s --no-cov` (prints the query count and a warm timing).

## Bugs found by testing

| Bug | How it was found | Fix |
|---|---|---|
| The Stripe webhook handler called `.get()` on Stripe event objects. With `stripe>=8` those aren't dicts, so **real** Stripe events would have crashed it. | The first tests replaced `construct_event` with plain dicts, which hid it. Testing against `stripe-mock` and signing real payloads exposed it. | Verify the signature, then parse the raw JSON payload. Tests now sign payloads exactly like Stripe instead of mocking verification. |
| Deleting a workspace (API or `seed_demo --reset`) failed with `ProtectedError`. Projects PROTECT their workflow and issues PROTECT their status. | Re-seeding during the end-to-end test. | `delete_workspace()` removes issues and projects first, inside one transaction. Regression tests added. |
| After cancelling, the Free plan still showed a renewal date. | End-to-end browser run of mock billing. | Clear `current_period_end` when a subscription is canceled. |

## Bugs found in code review (Days 2–6)

Each was fixed with a regression test in the suites above.

| Area | Bug | Fix |
|---|---|---|
| Accounts | Login failed for `Owner@Acme.test` although the account was stored as `owner@acme.test` | Case-insensitive login |
| Accounts | Django admin's add-user form saved users without an email, so they couldn't log in | Form asks for the email |
| Tenancy | Removed members kept receiving emails with issue titles | Notify current members only; unassign their open issues |
| Tenancy | Any admin could demote or remove other admins | Admin changes are owner-only |
| Tracker | Two Start clicks at once could leave two active sprints | Partial unique index |
| Tracker | Deleted attachments, issues and workspaces left their files on disk | Delete files after commit |
| Issues API | Changing status in the issue form left the card at a random position and sent no "moved" notification | Status edits go through the move logic |
| Issues API | `?assignee=abc` on the board returned a 500 | Validated, 400 |
| Billing UI | After cancelling, the page said "Payment received" | Message per outcome |
| Audit | A fake `X-Forwarded-For` header set the recorded IP and reset the login rate limit | Trust only our proxy's entry |
| Audit | The "append-only" log could be edited and deleted in Django admin | Enforced in the model, querysets and admin |

## Mock billing end to end (Playwright)
Free → **Upgrade** (simulated checkout) → **Subscribe** → Pro (sidebar badge updates) → **Manage** → Business → **Cancel** → Free. 0 console errors.
