import type { NextFunction, Request, Response } from "express";
import type { Role } from "../../generated/prisma/client.js";
import { prisma } from "../../lib/db.js";
import { badRequest, forbidden, notFound } from "../../lib/errors.js";

// Tenant isolation: one shared schema, every tenant-owned row carries workspaceId.
// Tenant routes resolve the workspace from the X-Workspace header (a header, not the URL, so slugs stay out of logs
// and browser history) and every query filters by it, so one company can never read another's rows.

export const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const ROLES = ["owner", "admin", "member", "viewer"] as const;

export const hasRole = (membership: { role: Role } | null | undefined, minimum: Role): boolean =>
  !!membership && ROLE_RANK[membership.role] >= ROLE_RANK[minimum];

// Middleware for tenant routes: X-Workspace → the caller's membership. Same 404 whether the workspace doesn't
// exist or the caller isn't a member, so tenant names don't leak.
export async function useWorkspace(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const slug = req.get("x-workspace");
  if (!slug) throw badRequest("X-Workspace header is required.");
  const membership = await prisma.membership.findFirst({
    where: { userId: req.user!.id, workspace: { slug } },
    include: { workspace: true },
  });
  if (!membership) throw notFound("Workspace not found.");
  const { workspace, ...m } = membership;
  req.workspace = workspace;
  req.membership = m;
  next();
}

export const ROLE_DENIED = "Your role in this workspace does not allow this action.";

// Refuse (403) unless the caller's role is at least `minimum` in the current workspace.
export function need(req: Request, minimum: Role): void {
  if (!hasRole(req.membership, minimum)) throw forbidden(ROLE_DENIED);
}

// The current workspace (for handlers behind useWorkspace).
export function ws(req: Request) {
  return req.workspace!;
}
