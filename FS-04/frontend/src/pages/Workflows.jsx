import { useEffect, useState } from "react";
import { api } from "../api";

export default function Workflows() {
  const [workflows, setWorkflows] = useState([]);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const load = () => api.list("/workflows/").then(setWorkflows);
  useEffect(() => { load(); }, []);
  const act = (fn) => async (...a) => { setError(""); try { await fn(...a); await load(); } catch (e) { setError(e.message); } };

  return (
    <div className="stack">
      <h2>Workflows</h2>
      <p className="muted small">Statuses become board columns. Transitions restrict which moves are allowed — with no transitions, cards move freely.</p>
      {error && <div className="error">{error}</div>}
      {workflows.map((wf) => <WorkflowEditor key={wf.id} wf={wf} act={act} />)}
      <form className="row gap panel" onSubmit={act(async (e) => { e.preventDefault(); await api.post("/workflows/", { name }); setName(""); })}>
        <input required placeholder="New workflow name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary">Create workflow</button>
      </form>
    </div>
  );
}

function WorkflowEditor({ wf, act }) {
  const [status, setStatus] = useState({ name: "", category: "todo", color: "#64748b" });
  const [tr, setTr] = useState({ from_status: "", to_status: "" });
  const name = (id) => wf.statuses.find((s) => s.id === id)?.name;
  return (
    <div className="panel stack">
      <div className="row between"><h3>{wf.name} {wf.is_default && <span className="badge">default</span>}</h3>
        {!wf.is_default && <button className="link danger-text" onClick={act(() => api.del(`/workflows/${wf.id}/`))}>Delete</button>}</div>
      <div className="row gap wrap">
        {wf.statuses.map((s) => (
          <span key={s.id} className="status-chip" style={{ borderColor: s.color }}>
            {s.name} <span className="muted small">({s.category})</span>
            <button className="link small" onClick={act(() => api.del(`/statuses/${s.id}/`))}>✕</button>
          </span>
        ))}
      </div>
      <form className="row gap wrap" onSubmit={act(async (e) => {
        e.preventDefault();
        await api.post("/statuses/", { ...status, workflow: wf.id, order: wf.statuses.length });
        setStatus({ ...status, name: "" });
      })}>
        <input required placeholder="Status name" value={status.name} onChange={(e) => setStatus({ ...status, name: e.target.value })} />
        <select value={status.category} onChange={(e) => setStatus({ ...status, category: e.target.value })}>
          <option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option>
        </select>
        <input type="color" value={status.color} onChange={(e) => setStatus({ ...status, color: e.target.value })} />
        <button>Add status</button>
      </form>
      <div>
        <strong className="small">Transitions</strong>
        <ul className="small">
          {wf.transitions.length === 0 && <li className="muted">None — free movement between all statuses.</li>}
          {wf.transitions.map((t) => (
            <li key={t.id}>{name(t.from_status)} → {name(t.to_status)}{" "}
              <button className="link small" onClick={act(() => api.del(`/transitions/${t.id}/`))}>remove</button></li>
          ))}
        </ul>
        <form className="row gap" onSubmit={act(async (e) => {
          e.preventDefault();
          await api.post("/transitions/", { workflow: wf.id, from_status: Number(tr.from_status), to_status: Number(tr.to_status) });
        })}>
          <select required value={tr.from_status} onChange={(e) => setTr({ ...tr, from_status: e.target.value })}>
            <option value="">from…</option>{wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <select required value={tr.to_status} onChange={(e) => setTr({ ...tr, to_status: e.target.value })}>
            <option value="">to…</option>{wf.statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          <button>Add transition</button>
        </form>
      </div>
    </div>
  );
}
