import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, setWorkspace } from "../api";
import { useAuth } from "../auth";

export default function Workspaces() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setLoadError("");
    api.list("/workspaces/").then(setList).catch((err) => setLoadError(err.message));
  }, []);
  useEffect(() => { setWorkspace(null); load(); }, [load]);

  const create = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try { const ws = await api.post("/workspaces/", { name }); navigate(`/w/${ws.slug}`); }
    catch (err) { setError(err.message); setBusy(false); }
  };

  return (
    <div className="auth">
      <div className="auth-card stack" style={{ width: 460 }}>
        <div className="row between"><h2>Your workspaces</h2><span className="row gap"><Link className="small" to="/account">Account</Link><button className="link" onClick={logout}>Sign out</button></span></div>
        <p className="muted small">Signed in as {user.email}. Each workspace is a fully isolated company tenant.</p>
        {loadError && (
          <div className="error row between" role="alert">{loadError}<button className="link" onClick={load}>Try again</button></div>
        )}
        {list === null && !loadError && <p className="muted">Loading…</p>}
        {list?.map((w) => (
          <button key={w.id} className="ws-item" onClick={() => navigate(`/w/${w.slug}`)}>
            <strong>{w.name}</strong><span className="muted small">{w.role} · {w.plan}</span>
          </button>
        ))}
        {list?.length === 0 && <p className="muted">You don't belong to any workspace yet. Create one below, or ask an admin to add you.</p>}
        <form onSubmit={create} className="row gap">
          <input required aria-label="New workspace name" placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create"}</button>
        </form>
        {error && <div className="error" role="alert">{error}</div>}
      </div>
    </div>
  );
}
