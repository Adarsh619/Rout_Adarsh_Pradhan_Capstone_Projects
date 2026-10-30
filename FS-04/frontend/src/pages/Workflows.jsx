import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { useWorkspace } from "../workspace";

export const FIRST_RULE_WARNING =
  "Once a workflow has any transition, cards can only make the moves listed. Every other move on boards using it is blocked. Add this rule?";

export default function Workflows() {
  const { projects } = useWorkspace();
  const [workflows, setWorkflows] = useState(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(() => api.list("/workflows/").then(setWorkflows).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const act = (fn) => async (...a) => { setError(""); try { await fn(...a); await load(); } catch (e) { setError(e.message); } };

  return (
    <div className="stack">
      <h2>Workflows</h2>
      <p className="muted small">Statuses become board columns, left to right. Transitions restrict which moves are allowed. With no transitions, cards move freely.</p>
      {error && <div className="error" role="alert">{error}</div>}
      {workflows === null && !error && <p className="muted">Loading…</p>}
      {workflows?.map((wf) => (
        <WorkflowEditor key={wf.id} wf={wf} act={act} usedBy={projects.filter((p) => p.workflow === wf.id)} />
      ))}
      <form className="row gap panel" onSubmit={act(async (e) => { e.preventDefault(); await api.post("/workflows/", { name }); setName(""); })}>
        <input required aria-label="New workflow name" placeholder="New workflow name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary">Create workflow</button>
      </form>
    </div>
  );
}

export function WorkflowEditor({ wf, act, usedBy = [] }) {
  const [status, setStatus] = useState({ name: "", category: "todo", color: "#64748b" });
  const [tr, setTr] = useState({ from_status: "", to_status: "" });
  const name = (id) => wf.statuses.find((s) => s.id === id)?.name;
  const nextOrder = Math.max(-1, ...wf.statuses.map((s) => s.order ?? 0)) + 1;
  const sameStatus = tr.from_status && tr.from_status === tr.to_status;
  const exists = wf.transitions.some((t) => String(t.from_status) === tr.from_status && String(t.to_status) === tr.to_status);

  // Swap the order of two neighbouring statuses (their columns swap on the board).
  const shift = (index, by) => act(async () => {
    const a = wf.statuses[index], b = wf.statuses[index + by];
    const [orderA, orderB] = a.order === b.order ? [index + by, index] : [b.order, a.order];
    await api.patch(`/statuses/${a.id}/`, { order: orderA });
    await api.patch(`/statuses/${b.id}/`, { order: orderB });
  })();

  return (
    <div className="panel stack">
      <div className="row between wrap gap">
        <div>
          <h3>{wf.name} {wf.is_default && <span className="badge">default</span>}</h3>
          <div className="muted small">
            {usedBy.length ? <>Used by {usedBy.map((p) => p.key).join(", ")}</> : "Not used by any project yet"}
          </div>
        </div>
        {!wf.is_default && usedBy.length === 0 && (
          <button className="link danger-text" onClick={act(async () => {
            if (window.confirm(`Delete the workflow "${wf.name}" and its statuses?`)) await api.del(`/workflows/${wf.id}/`);
          })}>Delete workflow</button>
        )}
      </div>
      <div className="row gap wrap">
        {wf.statuses.map((s, i) => (
          <span key={s.id} className="status-chip" style={{ borderColor: s.color }}>
            {i > 0 && <button className="link small" aria-label={`Move ${s.name} left`} onClick={() => shift(i, -1)}>‹</button>}
            {s.name} <span className="muted small">({s.category.replace("_", " ")})</span>
            {i < wf.statuses.length - 1 && <button className="link small" aria-label={`Move ${s.name} right`} onClick={() => shift(i, 1)}>›</button>}
            <button className="link small" aria-label={`Delete status ${s.name}`} onClick={act(async () => {
              if (window.confirm(`Delete the status "${s.name}"? Its transitions are removed too.`)) await api.del(`/statuses/${s.id}/`);
            })}>✕</button>
          </span>
        ))}
      </div>
      <form className="row gap wrap" onSubmit={act(async (e) => {
        e.preventDefault();
        await api.post("/statuses/", { ...status, workflow: wf.id, order: nextOrder });
        setStatus({ ...status, name: "" });
      })}>
        <input required aria-label="Status name" placeholder="Status name" value={status.name} onChange={(e) => setStatus({ ...status, name: e.target.value })} />
        <select aria-label="Category" value={status.category} onChange={(e) => setStatus({ ...status, category: e.target.value })}>
          <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
        </select>
        <input type="color" aria-label="Colour" value={status.color} onChange={(e) => setStatus({ ...status, color: e.target.value })} />
        <button>Add status</button>
      </form>
      <div>
        <strong className="small">Transitions</strong>
        <ul className="small">
          {wf.transitions.length === 0 && <li className="muted">None: cards can move between any statuses.</li>}
          {wf.transitions.map((t) => (
            <li key={t.id}>{name(t.from_status)} → {name(t.to_status)}{" "}
              <button className="link small" onClick={act(() => api.del(`/transitions/${t.id}/`))}>remove</button></li>
          ))}
        </ul>
        <form className="row gap wrap" onSubmit={act(async (e) => {
          e.preventDefault();
          if (wf.transitions.length === 0 && !window.confirm(FIRST_RULE_WARNING)) return;
          await api.post("/transitions/", { workflow: wf.id, from_status: Number(tr.from_status), to_status: Number(tr.to_status) });
          setTr({ from_status: "", to_status: "" });
        })}>
          <select required aria-label="From status" value={tr.from_status} onChange={(e) => setTr({ ...tr, from_status: e.target.value })}>
            <option value="">from…</option>{wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select required aria-label="To status" value={tr.to_status} onChange={(e) => setTr({ ...tr, to_status: e.target.value })}>
            <option value="">to…</option>{wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button disabled={sameStatus || exists}>Add transition</button>
          {sameStatus && <span className="muted small">Pick two different statuses.</span>}
          {exists && <span className="muted small">That move is already allowed.</span>}
        </form>
      </div>
    </div>
  );
}
