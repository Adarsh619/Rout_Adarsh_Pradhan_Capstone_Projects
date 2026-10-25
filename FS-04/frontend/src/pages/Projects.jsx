import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { can, useWorkspace } from "../workspace";

export default function Projects() {
  const { slug } = useParams();
  const { projects, reloadProjects, role } = useWorkspace();
  const [workflows, setWorkflows] = useState([]);
  const [form, setForm] = useState({ key: "", name: "", description: "", workflow: "" });
  const [error, setError] = useState("");
  const admin = can(role, "admin");

  useEffect(() => { if (admin) api.list("/workflows/").then(setWorkflows); }, [admin]);

  const create = async (e) => {
    e.preventDefault();
    setError("");
    const body = { ...form };
    if (!body.workflow) delete body.workflow; else body.workflow = Number(body.workflow);
    try { await api.post("/projects/", body); setForm({ key: "", name: "", description: "", workflow: "" }); reloadProjects(); }
    catch (err) { setError(err.status === 402 ? `${err.message} → see Billing.` : err.message); }
  };

  return (
    <div className="stack">
      <h2>Projects</h2>
      <div className="grid-cards">
        {projects.map((p) => (
          <div key={p.id} className="panel">
            <div className="row between"><strong>{p.name}</strong><span className="badge">{p.key}</span></div>
            <p className="muted small">{p.description || "No description"}</p>
            <div className="row between small">
              <span>{p.issue_count} issues</span>
              <span className="row gap">
                <Link to={`/w/${slug}/p/${p.id}/board`}>Board</Link>
                <Link to={`/w/${slug}/p/${p.id}/sprints`}>Sprints</Link>
              </span>
            </div>
          </div>
        ))}
        {projects.length === 0 && <p className="muted">No projects yet.</p>}
      </div>
      {admin && (
        <form className="panel stack" onSubmit={create} style={{ maxWidth: 520 }}>
          <h3>New project</h3>
          <div className="grid-2">
            <label>Key<input required maxLength={10} placeholder="WEB" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} /></label>
            <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
          <label>Description<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>Workflow<select value={form.workflow} onChange={(e) => setForm({ ...form, workflow: e.target.value })}>
            <option value="">Default workflow</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select></label>
          {error && <div className="error">{error}</div>}
          <button className="primary">Create project</button>
        </form>
      )}
    </div>
  );
}
