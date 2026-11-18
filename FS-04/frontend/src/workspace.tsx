import { createContext, useContext, type ReactNode } from "react";
import type { Me, Member, Project, Role, Workspace } from "./types";

// What every workspace page can read: the workspace, your role in it, its members and projects.
export interface WorkspaceState {
  workspace: Workspace;
  role: Role;
  members: Member[];
  projects: Project[];
  reloadProjects: () => Promise<unknown>;
  reloadMembers: () => Promise<unknown>;
  reloadWorkspace: () => Promise<unknown>;
  user: Me;
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null);
export const useWorkspace = (): WorkspaceState => {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used inside a workspace page");
  return ctx;
};

const RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const can = (role: Role | null | undefined, minimum: Role): boolean => (role ? RANK[role] : -1) >= RANK[minimum];

const ARTICLE: Record<Role, string> = { viewer: "a viewer", member: "a member", admin: "an admin", owner: "the owner" };

/** Wraps a page that needs at least `minimum`; others get an explanation instead of failed requests. */
export function RequireRole({ minimum, children }: { minimum: Role; children: ReactNode }) {
  const { role, workspace } = useWorkspace();
  if (can(role, minimum)) return <>{children}</>;
  return (
    <div className="center empty-state">
      <div className="empty-code" aria-hidden="true">🔒</div>
      <h2>{minimum === "admin" ? "Admins only" : "Not available to viewers"}</h2>
      <p className="muted">This page needs the <b>{minimum}</b> role or higher. You're {ARTICLE[role] ?? role} in {workspace.name}.</p>
    </div>
  );
}
