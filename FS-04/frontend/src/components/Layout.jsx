import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate, useParams } from "react-router-dom";
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
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);

  const reloadProjects = useCallback(() => api.list("/projects/").then(setProjects), []);
  const reloadMembers = useCallback(() => api.list("/members/").then(setMembers), []);
  const reloadWorkspace = useCallback(() => api.get(`/workspaces/${slug}/`).then(setWs), [slug]);

  useEffect(() => {
    let active = true; // ignore answers for a workspace we've already left
    setWorkspace(slug); // the tenant header for every request below and in the pages
    setError(null);
    (async () => {
      try {
        const ws = await api.get(`/workspaces/${slug}/`);
        const [m, p] = await Promise.all([api.list("/members/"), api.list("/projects/")]);
        if (!active) return;
        setMembers(m);
        setProjects(p);
        setWs(ws);
      } catch (err) {
        if (active) setError(err);
      }
    })();
    return () => { active = false; };
  }, [slug, attempt]);

  if (error?.status === 404) {
    return (
      <div className="center empty-state">
        <div className="empty-code">404</div>
        <h2>Workspace not found</h2>
        <p className="muted">It doesn't exist, or you aren't a member of it.</p>
        <Link className="button primary" to="/">Your workspaces</Link>
      </div>
    );
  }
  if (error) {
    return (
      <div className="center empty-state">
        <h2>Couldn't open this workspace</h2>
        <p className="muted">{error.message}</p>
        <div className="row gap">
          <button className="primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
          <Link className="button" to="/">Your workspaces</Link>
        </div>
      </div>
    );
  }
  // Pages only render once this workspace (not the previous one) is loaded.
  if (workspace?.slug !== slug) return <div className="center muted">Loading workspace…</div>;

  const role = workspace.role;
  const ctx = { workspace, role, members, projects, reloadProjects, reloadMembers, reloadWorkspace, user };
  const link = ({ isActive }) => (isActive ? "nav-link active" : "nav-link");

  return (
    <WorkspaceContext.Provider value={ctx}>
      <div className="app">
        <aside className="sidebar">
          <button className="brand" onClick={() => navigate("/")} title="Switch workspace">
            <span className="logo">▦</span>
            <div>
              <div className="ws-name">{workspace.name}</div>
              <div className="muted small">{workspace.plan} plan · {role}</div>
            </div>
          </button>
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
            <Link className="small" to="/account" state={{ from: `/w/${slug}` }} title="Your account and password">{user.display_name}</Link>
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
