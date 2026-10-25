import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setWorkspace } from "../api";
import { useAuth } from "../auth";

export default function Workspaces() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [list, setList] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");

  useEffect(() => { setWorkspace(null); api.list("/workspaces/").then(setList); }, []);

  const create = async (e) => {
    e.preventDefault();
    try { const ws = await api.post("/workspaces/", { name }); navigate(`/w/${ws.slug}`); }
    catch (err) { setError(err.message); }
  };

  return (
    <div className="auth">
      <div className="auth-card stack" style={{ width: 460 }}>
        <div className="row between"><h2>Your workspaces</h2><button className="link" onClick={logout}>Sign out</button></div>
        <p className="muted small">Signed in as {user.email}. Each workspace is a fully isolated company tenant.</p>
        {list === null && <p className="muted">Loading…</p>}
        {list?.map((w) => (
          <button key={w.id} className="ws-item" onClick={() => navigate(`/w/${w.slug}`)}>
            <strong>{w.name}</strong><span className="muted small">{w.role} · {w.plan}</span>
          </button>
        ))}
        {list?.length === 0 && <p className="muted">You don't belong to any workspace yet.</p>}
        <form onSubmit={create} className="row gap">
          <input required placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button className="primary">Create</button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
