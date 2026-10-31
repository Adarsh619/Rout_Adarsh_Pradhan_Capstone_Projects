# 13 · Challenges and next steps

[← Testing and performance](12-testing.md) · [Index](README.md) · [Next: Setup →](14-setup.md)

The hardest parts were keeping card order consistent during drag-and-drop, guaranteeing tenant isolation, and building billing without access to Stripe.

## Challenges and decisions

| Challenge | Decision or fix |
|---|---|
| Card order during concurrent drags | Float `rank` per card; the destination column is re-numbered inside one locked transaction; the UI updates optimistically and rolls back on error |
| Isolation that cannot be forgotten | One mixin owns tenant lookup, filtering and stamping; tenant-aware foreign-key fields; dedicated isolation tests |
| Webhooks for changes that roll back | Queue deliveries with `transaction.on_commit` |
| Duplicate Stripe events | Store processed event IDs; a repeat returns "duplicate" without changing anything |
| Stripe is invite-only in India | Mock mode on Stripe's official `stripe-mock` with properly signed webhooks; real keys still work |
| N+1 queries on the board | `select_related` and annotations keep the board at 7 queries |
| Project in a repo subfolder | CI workflow at the repo root with `FS-04/` path prefixes and path filters |
| Stripe events arrive late, twice or out of order | Remember the time of the last event applied per subscription; ignore older ones and ones for other subscriptions; mark an event processed only if applying it succeeds |
| Webhook URLs can point inside our network (SSRF) | Only public http(s) addresses; resolve the host again before every delivery; no redirects |
| Drop position on a filtered board | Send the neighbouring card's id, not just an index, because hidden cards shift the index |
| Code committed in one go | Review each area on its own day, fix what the review finds with a test, and commit that as the day's work (log below) |

## Bugs found by testing

| Bug | Found by | Fix |
|---|---|---|
| The Stripe webhook handler would have crashed on real Stripe events: newer Stripe SDK objects are not dictionaries | Testing against `stripe-mock` with properly signed payloads; earlier tests faked the events | Parse the raw JSON after verifying the signature |
| Deleting a workspace (and re-seeding demo data) failed on protected links | End-to-end re-seeding | `delete_workspace()` removes issues and projects first, in one transaction |
| A cancelled plan still showed a renewal date | Browser test of billing | Clear the period end on cancellation |

## Day-by-day review (Days 2–14)

All code was first committed together, so instead of re-committing it file by file, each day took one area, reviewed it, fixed what was wrong, added tests and updated these docs. Each row is one commit on `main`.

| Day | Area | Commit | Main findings and fixes |
|---|---|---|---|
| 2 | Accounts | `0a0916d` | Login failed for `Owner@Acme.test`; admin's add-user form created users without email; no rate limit on login; weak passwords accepted; no logout or password change. Added rotating refresh tokens with revocation |
| 3 | Tenancy | `91f85e3` | Removed members kept getting emails about issues; any admin could demote other admins; added leaving a workspace and ownership transfer; workspace renames audited |
| 4 | Data model | `a60578f` | Two sprints could be active at once; deleted attachments left files on disk; cross-workspace links possible through Django admin; database constraints added |
| 5 | Issues API | `8f7c77b`, `375e95b` | Status changes in the issue form skipped the move logic; `?assignee=abc` crashed the board; issues could join closed sprints; any member could delete anyone's issue (now reporter or admin, with "ask an admin") |
| 6 | Audit | `a476143` | A fake `X-Forwarded-For` header could set the audit IP and dodge the login limit; the append-only log could be edited in admin; added filters and CSV export |
| 7 | Tests and seed | `1d4c476` | Suite took 3.5 min (now ~45 s); coverage gate at 90%; real query-count assertion for the board; seed data made consistent and protected from production |
| 8 | Webhooks and jobs | `d2dfdc4` | Webhooks could reach internal services (SSRF); event list incomplete; permanent errors retried; added secret rotation, redelivery, log clean-up |
| 9 | Billing | `126214b` | A late "deleted" event could downgrade a paying workspace; a failed event was still marked processed; two quick Upgrade clicks could create two subscriptions |
| 10 | React foundation | `198890c` | Login forgot the page you came from; a proxy's HTML error page crashed the API client; expired sessions left broken pages; dialogs not keyboard-accessible; notification polling in hidden tabs |
| 11 | Kanban board | `74462c7` | Drops on a filtered board landed among hidden cards; double-click created duplicate issues; backlog showed only the first 100 issues; search raced |
| 12 | Admin pages | `6c09d55` | Destructive actions on one click; admin pages blank for members; first workflow rule silently blocked every move; report refresh guessed a delay |
| 13 | Docker and CI | `7f58ebb` | Images never started in CI (now a Compose smoke test); `.venv` copied into the image; workers could start before migrations; database port open to the network; nginx caching and headers |
| 14 | Docs | `74ac210` | README, index, overview, features and this log brought up to date with Days 2–13 |
| 14+ | Account page | `73583a9` | Password change was API-only: added an account page (name, password) and fixed password hints being read as part of the field's name |
| 14+ | Release pipeline | this commit | "Deploy" did nothing but print a notice: the pipeline now publishes multi-arch images, **verifies the published images by running them**, records the deployment, and turns `v*` tags into GitHub Releases; `docker-compose.release.yml` runs any release with one command |

## Known limits

- Tokens are kept in `localStorage`; a production launch should move them to httpOnly cookies (see [Security](10-security.md)).
- A webhook host whose DNS changes between our check and the request (DNS rebinding) isn't fully covered.
- Rate limits use the in-memory cache, so they count per gunicorn worker until a shared Redis cache is configured.
- Attachments are stored on the server's disk volume.
- The board doesn't update live; other people's moves appear after a reload or the next action.

## Next steps

- A live public server (for example Oracle Cloud's free ARM tier) using the ready `deploy-server` job, with HTTPS and protected demo accounts
- Email invitations for people who don't have an account yet
- Real-time board updates with WebSockets
- Attachment storage on S3-compatible object storage
- PostgreSQL Row-Level Security as a second isolation layer
- Full-text search, burndown charts and sprint velocity
- Browser end-to-end tests (Playwright) in CI, on top of the Compose smoke test
