# 04 · Multi-tenancy

[← System architecture](03-architecture.md) · [Index](README.md) · [Next: Data model →](05-data-model.md)

All companies share one database and one schema; every tenant-owned row carries a `workspace_id`, and the API filters every query by it.
This was the brief's suggested option and the simplest to build, migrate and test.

## Strategy comparison

| Strategy | Strength of isolation | Cost | Chosen |
|---|---|---|---|
| Shared schema + `workspace_id` | Enforced in application code and tests | One schema, one migration path, cheap | ✅ |
| Schema per tenant | Database-level separation | Migrations run N times; connection routing | |
| Database per tenant | Strongest | Expensive; heavy operations | |

## How isolation is enforced (`apps/tenancy`)

1. Every tenant model inherits the abstract `TenantModel`, which adds an indexed `workspace` foreign key.
2. The client sends `X-Workspace: <slug>` on each request. `TenantScopedMixin` looks up the caller's membership in that workspace and attaches `request.workspace` and `request.membership`.
3. Not a member → **404**, not 403, so outsiders cannot even confirm a workspace exists.
4. `get_queryset()` always filters by `request.workspace`; `perform_create()` always stamps it.
5. Foreign keys in request bodies (`TenantPKField`, `MemberPKField`) only accept objects and users from the same workspace, which blocks cross-tenant references by guessed IDs.
6. Attachments are downloaded through a tenant-checked endpoint, never from a public file URL.

```python
# apps/tenancy/mixins.py (simplified)
class TenantScopedMixin:
    permission_classes = [WorkspaceRolePermission]

    def get_queryset(self):
        return super().get_queryset().filter(workspace=self.request.workspace)

    def perform_create(self, serializer):
        serializer.save(workspace=self.request.workspace)
```

## Proof

`backend/tests/test_auth_and_tenancy.py::test_tenant_isolation` shows that a user in tenant B:

- sees an empty list of tenant A's issues,
- gets 404 reading tenant A's project by ID,
- cannot create an issue in tenant A's project (400),
- cannot impersonate tenant A by sending its slug in the header (404).

## Possible hardening

PostgreSQL Row-Level Security policies keyed on a per-request session variable would add a second, database-level layer.
