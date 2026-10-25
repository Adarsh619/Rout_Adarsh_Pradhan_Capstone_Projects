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

## Bugs found by testing

| Bug | Found by | Fix |
|---|---|---|
| The Stripe webhook handler would have crashed on real Stripe events: newer Stripe SDK objects are not dictionaries | Testing against `stripe-mock` with properly signed payloads; earlier tests faked the events | Parse the raw JSON after verifying the signature |
| Deleting a workspace (and re-seeding demo data) failed on protected links | End-to-end re-seeding | `delete_workspace()` removes issues and projects first, in one transaction |
| A cancelled plan still showed a renewal date | Browser test of billing | Clear the period end on cancellation |

## Next steps

- Email invitations for people who don't have an account yet
- Real-time board updates with WebSockets
- Attachment storage on S3-compatible object storage
- PostgreSQL Row-Level Security as a second isolation layer
- Full-text search, burndown charts and sprint velocity
