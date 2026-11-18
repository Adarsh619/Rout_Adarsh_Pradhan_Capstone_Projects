import { useEffect, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, messageOf, statusOf } from "../api";
import { can, useWorkspace } from "../workspace";
import type { Workflow } from "../types";

export default function Projects() {
  const { slug } = useParams();
  const { projects, reloadProjects, role } = useWorkspace();
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [form, setForm] = useState({ key: "", name: "", description: "", workflow: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = can(role, "admin");

  useEffect(() => { if (admin) api.list<Workflow>("/workflows/").then(setWorkflows); }, [admin]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const { workflow, ...fields } = form;
    const body = workflow ? { ...fields, workflow: Number(workflow) } : fields;
    setBusy(true);
    try { await api.post("/projects/", body); setForm({ key: "", name: "", description: "", workflow: "" }); await reloadProjects(); }
    catch (err) { setError(statusOf(err) === 402 ? `${messageOf(err)} → see Billing.` : messageOf(err)); }
    setBusy(false);
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
        {projects.length === 0 && <p className="muted">No projects yet.{admin ? " Create the first one below." : " Ask an admin to create one."}</p>}
      </div>
      {admin && (
        <form className="panel stack" onSubmit={create} style={{ maxWidth: 520 }}>
          <h3>New project</h3>
          <div className="grid-2">
            <label>Key<input required maxLength={10} placeholder="WEB" pattern="[A-Z0-9]+" title="Letters A–Z and digits only, e.g. WEB or APP2"
              value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })} /></label>
            <label>Name<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          </div>
          <label>Description<input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
          <label>Workflow<select value={form.workflow} onChange={(e) => setForm({ ...form, workflow: e.target.value })}>
            <option value="">Default workflow</option>
            {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select></label>
          <p className="muted small">The key prefixes issue numbers (WEB-1, WEB-2…) and can't be changed later.</p>
          {error && <div className="error" role="alert">{error}</div>}
          <button className="primary" disabled={busy}>{busy ? "Creating…" : "Create project"}</button>
        </form>
      )}
    </div>
  );
}
