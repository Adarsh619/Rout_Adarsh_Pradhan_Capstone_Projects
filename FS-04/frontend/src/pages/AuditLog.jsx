import { useCallback, useEffect, useState } from "react";
import { api, download } from "../api";
import { actionTone, AUDIT_KINDS, describeAction, formatChanges } from "../auditFormat";
import { useWorkspace } from "../workspace";

const PAGE = 50;
const NO_FILTERS = { search: "", kind: "", actor_email: "", since: "", until: "" };

export default function AuditLog() {
  const { members, workspace } = useWorkspace();
  const [filters, setFilters] = useState(NO_FILTERS);
  const [entries, setEntries] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // The same query string drives the list, "Load more" and the CSV export.
  const query = useCallback(() => {
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && p.set(k, v));
    return p.toString();
  }, [filters]);

  const load = useCallback(async (offset = 0) => {
    setLoading(true);
    setError("");
    try {
      const page = await api.get(`/audit-logs/?limit=${PAGE}&offset=${offset}&${query()}`);
      setEntries((prev) => (offset ? [...prev, ...page.results] : page.results));
      setTotal(page.count);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }, [query]);

  useEffect(() => {
    const t = setTimeout(() => load(0), 250); // debounce typing in the search box
    return () => clearTimeout(t);
  }, [load]);

  const set = (k) => (e) => setFilters({ ...filters, [k]: e.target.value });
  const filtered = Object.values(filters).some(Boolean);
  const exportCsv = () => download(`/audit-logs/export/?${query()}`, `audit-log-${workspace.slug}.csv`).catch((e) => setError(e.message));

  return (
    <div className="stack">
      <div className="row between wrap gap">
        <div>
          <h2>Audit log</h2>
          <p className="muted small">Every change in this workspace: who made it, when, from which IP address, and what changed. Entries can't be edited or deleted.</p>
        </div>
        <button onClick={exportCsv} disabled={!total}>Export CSV</button>
      </div>

      <div className="row gap filters audit-filters">
        <input placeholder="Search entity, action or person…" value={filters.search} onChange={set("search")} />
        <select value={filters.kind} onChange={set("kind")} aria-label="Kind of change">
          <option value="">All kinds</option>
          {AUDIT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select value={filters.actor_email} onChange={set("actor_email")} aria-label="Person">
          <option value="">Everyone</option>
          {members.map((m) => <option key={m.user.id} value={m.user.email}>{m.user.display_name}</option>)}
        </select>
        <label className="row gap inline-label">From<input type="date" value={filters.since} onChange={set("since")} /></label>
        <label className="row gap inline-label">To<input type="date" value={filters.until} onChange={set("until")} /></label>
        {filtered && <button className="link" onClick={() => setFilters(NO_FILTERS)}>Clear filters</button>}
      </div>

      {error && <div className="error">{error}</div>}
      <div className="table-wrap panel">
        <table className="table small audit-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Changes</th></tr></thead>
          <tbody>
            {entries.map((l) => {
              const changes = formatChanges(l.changes);
              const when = new Date(l.created_at);
              return (
                <tr key={l.id}>
                  <td className="nowrap">{when.toLocaleDateString()}<div className="muted">{when.toLocaleTimeString()}</div></td>
                  <td>{l.actor_email || <span className="muted">system</span>}
                    {l.ip_address && <div className="muted">{l.ip_address}</div>}</td>
                  <td><span className={`badge tone-${actionTone(l.action)}`}>{describeAction(l.action)}</span></td>
                  <td>{l.entity_label}<div className="muted">{l.entity_type} #{l.entity_id}</div></td>
                  <td>
                    {changes.length === 0 ? <span className="muted">—</span> : (
                      <ul className="changes">
                        {changes.map((c) => <li key={c.label}><span className="muted">{c.label}:</span> {c.text}</li>)}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!loading && entries.length === 0 && (
          <p className="muted center-text">{filtered ? "No entries match these filters." : "Nothing has happened in this workspace yet."}</p>
        )}
      </div>

      <div className="row between">
        <span className="muted small">{total ? `Showing ${entries.length} of ${total}` : ""}</span>
        {entries.length < total && (
          <button onClick={() => load(entries.length)} disabled={loading}>{loading ? "Loading…" : "Load more"}</button>
        )}
      </div>
    </div>
  );
}
