import { useEffect, useState } from "react";
import { api } from "../api";

export default function AuditLog() {
  const [logs, setLogs] = useState([]);
  const [search, setSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => api.list(`/audit-logs/?limit=200${search ? `&search=${encodeURIComponent(search)}` : ""}`).then(setLogs), 250);
    return () => clearTimeout(t);
  }, [search]);
  return (
    <div className="stack">
      <div className="row between"><h2>Audit log</h2>
        <input placeholder="Filter by action or entity…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
      <table className="table panel small">
        <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Changes</th></tr></thead>
        <tbody>
          {logs.map((l) => (
            <tr key={l.id}>
              <td>{new Date(l.created_at).toLocaleString()}</td>
              <td>{l.actor_email ?? "system"}</td>
              <td><span className="badge">{l.action}</span></td>
              <td>{l.entity_label}</td>
              <td><code>{Object.keys(l.changes || {}).length ? JSON.stringify(l.changes) : ""}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
