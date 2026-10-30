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
  const [workflow, setWorkflow] = useState({ statuses: [], transitions: [] });
  const [notice, setNotice] = useState("");
  const [form, setForm] = useState({ name: "", goal: "", start_date: "", end_date: "" });
  const [error, setError] = useState("");
  const [open, setOpen] = useState(null);
  const admin = can(role, "admin");

  const load = useCallback(async () => {
    try {
      // Every issue, not just the first page of 100, so big backlogs aren't cut off.
      const [s, i] = await Promise.all([api.list(`/sprints/?project=${projectId}`), api.all(`/issues/?project=${projectId}&ordering=rank`)]);
      setSprints(s);
      setIssues(i);
    } catch (e) { setError(e.message); }
  }, [projectId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (project) api.get(`/workflows/${project.workflow}/`).then(setWorkflow).catch(() => {});
  }, [project]);

  const run = (fn) => async (...a) => { setError(""); setNotice(""); try { await fn(...a); await load(); } catch (e) { setError(e.message); } };
  const create = run(async (e) => {
    e.preventDefault();
    await api.post("/sprints/", { ...form, project: Number(projectId), start_date: form.start_date || null, end_date: form.end_date || null });
    setForm({ name: "", goal: "", start_date: "", end_date: "" });
  });
  const assign = run((issue, sprint) => api.patch(`/issues/${issue.id}/`, { sprint: sprint || null }));

  const complete = (sprint, unfinished) => run(async () => {
    const warning = unfinished ? ` ${unfinished} unfinished issue(s) go back to the backlog.` : "";
    if (!window.confirm(`Complete ${sprint.name}?${warning}`)) return;
    const r = await api.post(`/sprints/${sprint.id}/complete/`);
    setNotice(`${sprint.name} completed. ${r.returned_to_backlog} unfinished issue(s) returned to the backlog.`);
  })();

  const doneStatuses = new Set(workflow.statuses.filter((s) => s.category === "done").map((s) => s.id));
  const groups = [...sprints.filter((s) => s.state !== "closed"), { id: null, name: "Backlog", state: "backlog" }];
  const closed = sprints.filter((s) => s.state === "closed");

  return (
    <div className="stack">
      <div className="row between">
        <h2>Backlog & sprints — {project?.name}</h2>
        <Link className="button" to={`/w/${slug}/p/${projectId}/board`}>Open board</Link>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {notice && <div className="toast static" role="status">{notice}</div>}
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
        const finished = list.filter((i) => doneStatuses.has(i.status));
        const donePoints = finished.reduce((s, i) => s + (i.story_points || 0), 0);
        return (
          <div key={g.id ?? "backlog"} className="panel">
            <div className="row between">
              <div>
                <strong>{g.name}</strong> <span className={`state state-${g.state}`}>{g.state}</span>
                <span className="muted small"> · {list.length} issues · {points} pts {g.start_date && `· ${g.start_date} → ${g.end_date ?? "?"}`}</span>
                {g.id && list.length > 0 && (
                  <div className="sprint-progress" title={`${finished.length} of ${list.length} issues done`}>
                    <div className="meter"><div style={{ width: `${(finished.length / list.length) * 100}%` }} /></div>
                    <span className="muted small">{finished.length}/{list.length} done · {donePoints}/{points} pts</span>
                  </div>
                )}
              </div>
              {admin && g.state === "planned" && <button onClick={run(() => api.post(`/sprints/${g.id}/start/`))}>Start sprint</button>}
              {admin && g.state === "active" && <button onClick={() => complete(g, list.length - finished.length)}>Complete sprint</button>}
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
                        <select aria-label={`Sprint for ${i.key}`} value={i.sprint ?? ""} onChange={(e) => assign(i, e.target.value ? Number(e.target.value) : null)}>
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
      {closed.length > 0 && (
        <details className="panel">
          <summary><strong>Completed sprints</strong> <span className="muted small">({closed.length})</span></summary>
          <ul className="closed-sprints">
            {closed.map((s) => (
              <li key={s.id}><strong>{s.name}</strong> <span className="muted small">{s.start_date && `${s.start_date} → ${s.end_date ?? "?"}`}{s.goal && ` · ${s.goal}`}</span></li>
            ))}
          </ul>
        </details>
      )}
      {open && <IssueModal issueId={open} projectId={projectId} statuses={workflow.statuses} transitions={workflow.transitions}
        sprints={sprints} onClose={() => setOpen(null)} onSaved={load} />}
    </div>
  );
}
