import { useCallback, useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
import { api, setWorkspace } from "../api";
import { useAuth } from "../auth";
import { can, WorkspaceContext } from "../workspace";
import Notifications from "./Notifications";

export default function Layout() {
  const { slug } = useParams();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [workspace, setWs] = useState(null);
  const [members, setMembers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");

  // Set the tenant header before any child request runs.
  useMemo(() => setWorkspace(slug), [slug]);

  const reloadProjects = useCallback(() => api.list("/projects/").then(setProjects), []);
  const reloadWorkspace = useCallback(() => api.get(`/workspaces/${slug}/`).then(setWs), [slug]);

  useEffect(() => {
    setWs(null);
    api.get(`/workspaces/${slug}/`)
      .then((ws) => {
        setWs(ws);
        api.list("/members/").then(setMembers);
        reloadProjects();
      })
      .catch(() => setError("Workspace not found or you are not a member."));
  }, [slug, reloadProjects]);

  if (error) return <div className="center"><p>{error}</p><button onClick={() => navigate("/")}>Back</button></div>;
  if (!workspace) return <div className="center muted">Loading workspace…</div>;

  const role = workspace.role;
  const ctx = { workspace, role, members, projects, reloadProjects, reloadWorkspace, user };
  const link = ({ isActive }) => (isActive ? "nav-link active" : "nav-link");

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <div className="brand" onClick={() => navigate("/")} title="Switch workspace">
            <span className="logo">▦</span>
            <div>
              <div className="ws-name">{workspace.name}</div>
              <div className="muted small">{workspace.plan} plan · {role}</div>
            </div>
          </div>
          <nav>
            <NavLink end to={`/w/${slug}`} className={link}>Projects</NavLink>
            {projects.map((p) => (
              <NavLink key={p.id} to={`/w/${slug}/p/${p.id}/board`} className={link} style={{ paddingLeft: 28 }}>
                <span className="badge">{p.key}</span> {p.name}
              </NavLink>
            ))}
            <div className="nav-section">Workspace</div>
            <NavLink to={`/w/${slug}/members`} className={link}>Members</NavLink>
            {can(role, "member") && <NavLink to={`/w/${slug}/reports`} className={link}>Reports</NavLink>}
            {can(role, "admin") && <>
              <NavLink to={`/w/${slug}/workflows`} className={link}>Workflows</NavLink>
              <NavLink to={`/w/${slug}/webhooks`} className={link}>Webhooks</NavLink>
              <NavLink to={`/w/${slug}/audit`} className={link}>Audit log</NavLink>
            </>}
            <NavLink to={`/w/${slug}/billing`} className={link}>Billing</NavLink>
          </nav>
          <div className="sidebar-footer">
            <div className="small">{user.display_name}</div>
            <button className="link" onClick={() => { logout(); navigate("/login"); }}>Sign out</button>
          </div>
        </aside>
        <main className="main">
          <header className="topbar">
            <div />
            <Notifications />
          </header>
          <div className="content"><Outlet /></div>
        </main>
      </div>
    </WorkspaceContext.Provider>
  );
}
