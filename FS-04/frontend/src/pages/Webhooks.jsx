import { useEffect, useState } from "react";
import { api } from "../api";

// "issue.created" → grouped under "issue", so the picker reads as a few short rows.
const groupEvents = (events) => events.reduce((groups, ev) => {
  const kind = ev.split(".")[0];
  return { ...groups, [kind]: [...(groups[kind] || []), ev] };
}, {});

const outcome = (d) => {
  if (d.success) return { icon: "✅", text: `${d.status_code}` };
  if (d.status_code) return { icon: "❌", text: `${d.status_code}` };
  return { icon: d.attempts ? "❌" : "⏳", text: d.attempts ? "no response" : "queued" };
};

export default function Webhooks() {
  const [hooks, setHooks] = useState([]);
  const [events, setEvents] = useState([]);
  const [url, setUrl] = useState("");
  const [selected, setSelected] = useState([]);
  const [deliveries, setDeliveries] = useState({});
  const [revealed, setRevealed] = useState({});
  const [error, setError] = useState("");
  const load = () => api.list("/webhooks/").then(setHooks);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    api.get("/webhooks/events/").then(setEvents).catch(() => {});
  }, []);
  const act = (fn) => async (...a) => { setError(""); try { await fn(...a); await load(); } catch (e) { setError(e.message); } };
  const showDeliveries = async (id) => setDeliveries({ ...deliveries, [id]: await api.get(`/webhooks/${id}/deliveries/`) });
  const rotate = (h) => act(async () => {
    if (!window.confirm("Create a new signing secret? Deliveries from now on are signed with it, so update your receiver.")) return;
    await api.post(`/webhooks/${h.id}/rotate_secret/`);
    setRevealed({ ...revealed, [h.id]: true });
  })();
  const redeliver = (h, d) => act(async () => {
    await api.post(`/webhooks/${h.id}/redeliver/`, { delivery: d.id });
    await showDeliveries(h.id);
  })();

  return (
    <div className="stack">
      <h2>Webhooks</h2>
      <p className="muted small">Events are POSTed as JSON by a Celery worker, signed with HMAC-SHA256 in <code>X-TaskFlow-Signature</code>, and retried with exponential backoff when the receiver is down or answers 5xx. URLs must be public: internal and private addresses are refused. Tip: use a free URL from webhook.site to watch them arrive.</p>
      {error && <div className="error">{error}</div>}
      {hooks.map((h) => (
        <div key={h.id} className="panel stack">
          <div className="row between wrap gap">
            <div className="hook-url"><strong>{h.url}</strong> <span className="badge">{h.is_active ? "active" : "paused"}</span></div>
            <div className="row gap wrap">
              <button onClick={act(() => api.post(`/webhooks/${h.id}/ping/`))}>Send ping</button>
              <button onClick={() => showDeliveries(h.id)}>Deliveries</button>
              <button onClick={act(() => api.patch(`/webhooks/${h.id}/`, { is_active: !h.is_active }))}>{h.is_active ? "Pause" : "Resume"}</button>
              <button className="danger" onClick={act(async () => {
                if (window.confirm(`Delete the webhook to ${h.url}? Its delivery log is deleted too.`)) await api.del(`/webhooks/${h.id}/`);
              })}>Delete</button>
            </div>
          </div>
          <div className="small muted">
            Events: {h.events.length ? h.events.join(", ") : "all"} · Secret:{" "}
            <code>{revealed[h.id] ? h.secret : "whsec_••••••••"}</code>{" "}
            <button className="link small" onClick={() => setRevealed({ ...revealed, [h.id]: !revealed[h.id] })}>{revealed[h.id] ? "hide" : "show"}</button>
            <button className="link small" onClick={() => rotate(h)}>rotate</button>
          </div>
          {deliveries[h.id] && (
            <div className="table-wrap">
              <table className="table small">
                <thead><tr><th>When</th><th>Event</th><th>Result</th><th>Attempts</th><th>Response</th><th /></tr></thead>
                <tbody>{deliveries[h.id].map((d) => {
                  const o = outcome(d);
                  return (
                    <tr key={d.id}><td className="nowrap">{new Date(d.created_at).toLocaleString()}</td><td>{d.event}</td>
                      <td className="nowrap">{o.icon} {o.text}</td><td>{d.attempts}</td>
                      <td className="muted response-cell" title={d.response_body}>{d.response_body || "—"}</td>
                      <td>{!d.success && d.attempts > 0 && <button className="link small" onClick={() => redeliver(h, d)}>Redeliver</button>}</td>
                    </tr>
                  );
                })}</tbody>
              </table>
              {deliveries[h.id].length === 0 && <p className="muted small center-text">No deliveries yet. Send a ping to test the URL.</p>}
            </div>
          )}
        </div>
      ))}
      <form className="panel stack" onSubmit={act(async (e) => { e.preventDefault(); await api.post("/webhooks/", { url, events: selected }); setUrl(""); setSelected([]); })}>
        <h3>Add webhook</h3>
        <input type="url" required placeholder="https://example.com/taskflow-hook" value={url} onChange={(e) => setUrl(e.target.value)} />
        <div className="event-groups small">
          {Object.entries(groupEvents(events)).map(([kind, evs]) => (
            <div key={kind} className="row gap wrap">
              <strong className="event-kind">{kind}</strong>
              {evs.map((ev) => (
                <label key={ev} className="check">
                  <input type="checkbox" checked={selected.includes(ev)}
                    onChange={(e) => setSelected(e.target.checked ? [...selected, ev] : selected.filter((x) => x !== ev))} /> {ev.split(".")[1].replaceAll("_", " ")}
                </label>
              ))}
            </div>
          ))}
        </div>
        <span className="muted small">Leave all unchecked to receive every event.</span>
        <button className="primary">Create webhook</button>
      </form>
    </div>
  );
}
