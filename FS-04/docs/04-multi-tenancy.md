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

## How isolation is enforced (`src/modules/tenancy`)

1. Every tenant table in `prisma/schema.prisma` has an indexed `workspaceId` foreign key to `workspaces`.
2. The client sends `X-Workspace: <slug>` on each request. Only the header is read, never a URL parameter, so tenant names stay out of access logs and browser history. The `useWorkspace` middleware looks up the caller's membership in that workspace and attaches `req.workspace` and `req.membership`.
3. Not a member → **404**, not 403, so outsiders cannot even confirm a workspace exists.
4. Every query a route makes filters by `workspaceId: ws(req).id`, and every create sets it. A row of another workspace is simply not found.
5. Ids in request bodies are looked up with `ref()` and `memberRef()` (`src/modules/tracker/common.ts`), which only accept rows and users of the same workspace and otherwise answer like a missing id. That blocks cross-tenant references by guessed IDs.
6. Attachments are downloaded through a tenant-checked endpoint, never from a public file URL.
7. Leaving is complete: when a membership ends (`removeMember()`), the person's open issues are unassigned, and notifications and emails only ever go to current members. Someone who has left hears nothing more about the workspace, even as the reporter of an old issue.

```ts
// src/modules/tenancy/context.ts (simplified)
export async function useWorkspace(req, _res, next) {
  const slug = req.get("x-workspace");
  if (!slug) throw badRequest("X-Workspace header is required.");
  const membership = await prisma.membership.findFirst({
    where: { userId: req.user.id, workspace: { slug } },
    include: { workspace: true },
  });
  if (!membership) throw notFound("Workspace not found."); // same answer whether it exists or not
  req.workspace = membership.workspace;
  req.membership = membership;
  next();
}

// a route (src/modules/tracker/projects.ts)
const project = await prisma.project.findFirst({ where: { id: routeId(req), workspaceId: ws(req).id } });
```

## Proof

`backend/tests/auth.test.ts` ("isolates tenants, even when ids are guessed") shows that a user in tenant B:

- sees an empty list of tenant A's issues,
- gets 404 reading tenant A's project by ID,
- cannot create an issue in tenant A's project (400),
- cannot impersonate tenant A by sending its slug in the header (404).

`backend/tests/rules.test.ts` checks that **every** tenant resource (13 URLs, plus a delete and an edit) answers 404 to another workspace. `backend/tests/tenancy.test.ts` covers the membership edges: a removed or departed member's open issues are unassigned and they get no further notifications, a slug in the URL is ignored, and only the owner can manage admins or hand over ownership.

## Membership lifecycle

| Event | Who | Effect | Audit action |
|---|---|---|---|
| Add a member | Admin (owner for the admin role) | Existing user joins with a role; counts toward the plan's member limit | `member.added` |
| Change a role | Admin (owner when an admin is involved) | Role updated; the owner's role can't be changed | `member.role_changed` |
| Remove a member | Admin (owner for an admin) | Membership deleted, open issues unassigned | `member.removed` |
| Leave | Anyone but the owner | Same as removal, done by the person themselves | `member.left` |
| Transfer ownership | Owner | Chosen member becomes owner; the old owner becomes admin | `workspace.ownership_transferred` |

## Possible hardening

PostgreSQL Row-Level Security policies keyed on a per-request session variable would add a second, database-level layer.
