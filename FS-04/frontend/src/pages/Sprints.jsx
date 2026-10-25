import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import IssueModal from "../components/IssueModal";
import { can, useWorkspace } from "../workspace";

export default function Sprints() {
  const { slug, projectId } = useParams();
  const { role, projects } = useWorkspace();
  const project = projects.find((p) => String(p.id) === projectId);
  const [sprints, setSprints] = useState([]);
  const [issues, setIssues] = useState([]);
  const [statuses, setStatuses] = useState([]);
  const [form, setForm] = useState({ name: "", goal: "", start_date: "", end_date: "" });
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const admin = can(role, "admin");

  const load = useCallback(async () => {
    setSprints(await api.list(`/sprints/?project=${projectId}`));
    setIssues(await api.list(`/issues/?project=${projectId}&ordering=rank`));
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (project) api.get(`/workflows/${project.workflow}/`).then((w) => setStatuses(w.statuses));
  }, [project]);

  const run = (fn) => async (...a) => { setError(""); try { await fn(...a); await load(); } catch (e) { setError(e.message); } };
  const create = run(async (e) => {
    e.preventDefault();
    await api.post("/sprints/", { ...form, project: Number(projectId), start_date: form.start_date || null, end_date: form.end_date || null });
    setForm({ name: "", goal: "", start_date: "", end_date: "" });
  });
  const assign = run((issue, sprint) => api.patch(`/issues/${issue.id}/`, { sprint: sprint || null }));

  const groups = [...sprints.filter((s) => s.state !== "closed"), { id: null, name: "Backlog", state: "backlog" }];

  return (
    <div className="stack">
      <div className="row between">
        <h2>Backlog & sprints — {project?.name}</h2>
        <Link className="button" to={`/w/${slug}/p/${projectId}/board`}>Open board</Link>
      </div>
      {error && <div className="error">{error}</div>}
      {admin && (
        <form className="row gap wrap panel" onSubmit={create}>
          <input required placeholder="Sprint name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input placeholder="Goal" value={form.goal} onChange={(e) => setForm({ ...form, goal: e.target.value })} />
          <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />
          <button className="primary">Create sprint</button>
        </form>
      )}
      {groups.map((g) => {
        const list = issues.filter((i) => (i.sprint ?? null) === g.id);
        const points = list.reduce((s, i) => s + (i.story_points || 0), 0);
        return (
          <div key={g.id ?? "backlog"} className="panel">
            <div className="row between">
              <div>
                <strong>{g.name}</strong> <span className={`state state-${g.state}`}>{g.state}</span>
                <span className="muted small"> · {list.length} issues · {points} pts {g.start_date && `· ${g.start_date} → ${g.end_date ?? "?"}`}</span>
              </div>
              {admin && g.state === "planned" && <button onClick={run(() => api.post(`/sprints/${g.id}/start/`))}>Start sprint</button>}
              {admin && g.state === "active" && <button onClick={run(async () => {
                const r = await api.post(`/sprints/${g.id}/complete/`);
                alert(`Sprint completed. ${r.returned_to_backlog} unfinished issue(s) returned to the backlog.`);
              })}>Complete sprint</button>}
            </div>
            <table className="table">
              <tbody>
                {list.map((i) => (
                  <tr key={i.id}>
                    <td className="muted" style={{ width: 80 }}>{i.key}</td>
                    <td><button className="link" onClick={() => setOpen(i.id)}>{i.title}</button></td>
                    <td style={{ width: 110 }}><span className="badge">{i.status_name}</span></td>
                    <td style={{ width: 120 }} className="small">{i.assignee_detail?.display_name ?? "—"}</td>
                    <td style={{ width: 170 }}>
                      {can(role, "member") && (
                        <select value={i.sprint ?? ""} onChange={(e) => assign(i, e.target.value ? Number(e.target.value) : null)}>
                          <option value="">Backlog</option>
                          {sprints.filter((s) => s.state !== "closed").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
                {list.length === 0 && <tr><td className="muted small">No issues.</td></tr>}
              </tbody>
            </table>
          </div>
        );
      })}
      {open && <IssueModal issueId={open} projectId={projectId} statuses={statuses} sprints={sprints} onClose={() => setOpen(null)} onSaved={load} />}
    </div>
  );
}
