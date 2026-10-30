import { createContext, useContext } from "react";

export const WorkspaceContext = createContext(null);
export const useWorkspace = () => useContext(WorkspaceContext);

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 };
export const can = (role, minimum) => (RANK[role] ?? -1) >= RANK[minimum];

const ARTICLE = { viewer: "a viewer", member: "a member", admin: "an admin", owner: "the owner" };

/** Wraps a page that needs at least `minimum`; others get an explanation instead of failed requests. */
export function RequireRole({ minimum, children }) {
  const { role, workspace } = useWorkspace();
  if (can(role, minimum)) return children;
  return (
    <div className="center empty-state">
      <div className="empty-code" aria-hidden="true">🔒</div>
      <h2>{minimum === "admin" ? "Admins only" : "Not available to viewers"}</h2>
      <p className="muted">This page needs the <b>{minimum}</b> role or higher. You're {ARTICLE[role] ?? role} in {workspace.name}.</p>
    </div>
  );
}
