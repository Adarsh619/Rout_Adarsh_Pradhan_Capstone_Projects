import { useEffect, useState } from "react";
import { api } from "../api";

export default function Webhooks() {
  const [hooks, setHooks] = useState([]);
  const [events, setEvents] = useState([]);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState([]);
  const [deliveries, setDeliveries] = useState({});
  const [error, setError] = useState("");
  const load = () => api.list("/webhooks/").then(setHooks);
  useEffect(() => { load(); api.get("/webhooks/events/").then(setEvents); }, []);
  const act = (fn) => async (...a) => { setError(""); try { await fn(...a); await load(); } catch (e) { setError(e.message); } };
  const showDeliveries = async (id) => setDeliveries({ ...deliveries, [id]: await api.get(`/webhooks/${id}/deliveries/`) });

  return (
    <div className="stack">
      <h2>Webhooks</h2>
      <p className="muted small">Events are POSTed as JSON by a Celery worker, signed with HMAC-SHA256 in <code>X-TaskFlow-Signature</code>, and retried with exponential backoff. Tip: use a free URL from webhook.site to watch them arrive.</p>
      {error && <div className="error">{error}</div>}
      {hooks.map((h) => (
        <div key={h.id} className="panel stack">
          <div className="row between">
            <div><strong>{h.url}</strong> <span className="badge">{h.is_active ? "active" : "paused"}</span></div>
            <div className="row gap">
              <button onClick={act(() => api.post(`/webhooks/${h.id}/ping/`))}>Send ping</button>
              <button onClick={() => showDeliveries(h.id)}>Deliveries</button>
              <button onClick={act(() => api.patch(`/webhooks/${h.id}/`, { is_active: !h.is_active }))}>{h.is_active ? "Pause" : "Resume"}</button>
              <button className="danger" onClick={act(() => api.del(`/webhooks/${h.id}/`))}>Delete</button>
            </div>
          </div>
          <div className="small muted">Events: {h.events.length ? h.events.join(", ") : "all"} · Secret: <code>{h.secret}</code></div>
          {deliveries[h.id] && (
            <table className="table small">
              <thead><tr><th>When</th><th>Event</th><th>Status</th><th>Attempts</th></tr></thead>
              <tbody>{deliveries[h.id].map((d) => (
                <tr key={d.id}><td>{new Date(d.created_at).toLocaleString()}</td><td>{d.event}</td>
                  <td>{d.success ? "✅" : "❌"} {d.status_code ?? "—"}</td><td>{d.attempts}</td></tr>))}</tbody>
            </table>
          )}
        </div>
      ))}
      <form className="panel stack" onSubmit={act(async (e) => { e.preventDefault(); await api.post("/webhooks/", { url, events: selected }); setUrl(""); setSelected([]); })}>
        <h3>Add webhook</h3>
        <input type="url" required placeholder="https://example.com/taskflow-hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="row gap wrap small">
          {events.map((ev) => (
            <label key={ev} className="check">
              <input type="checkbox" checked={selected.includes(ev)}
                onChange={(e) => setSelected(e.target.checked ? [...selected, ev] : selected.filter((x) => x !== ev))} /> {ev}
            </label>
          ))}
        </div>
        <span className="muted small">Leave all unchecked to receive every event.</span>
        <button className="primary">Create webhook</button>
      </form>
    </div>
  );
}
