import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { can, useWorkspace } from "../workspace";

export const POLL_EVERY_MS = 2000;
export const POLL_TRIES = 15; // about 30 seconds

const day = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

export default function Reports() {
  const { role } = useWorkspace();
  const [reports, setReports] = useState(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const timer = useRef(null);

  const load = useCallback(() => api.list("/reports/").then((r) => { setReports(r); return r; }), []);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);

  // The report is built by the Celery worker, so check back until it shows up instead of guessing a delay.
  const generate = async () => {
    setError("");
    setMsg("");
    try {
      const before = reports?.[0]?.id;
      await api.post("/reports/generate/");
      setWaiting(true);
      setMsg("Generating the report on the background worker…");
      let tries = 0;
      const check = async () => {
        tries += 1;
        const list = await load().catch(() => null);
        if (list?.[0] && list[0].id !== before) { setWaiting(false); setMsg("New report ready."); return; }
        if (tries >= POLL_TRIES) {
          setWaiting(false);
          setMsg("");
          setError("The report hasn't appeared yet. The background worker may be busy or stopped; refresh in a minute.");
          return;
        }
        timer.current = setTimeout(check, POLL_EVERY_MS);
      };
      timer.current = setTimeout(check, POLL_EVERY_MS);
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="stack">
      <div className="row between"><h2>Reports</h2>
        {can(role, "admin") && <button className="primary" onClick={generate} disabled={waiting}>{waiting ? "Generating…" : "Generate now"}</button>}</div>
      <p className="muted small">A summary of the last 7 days is generated every Monday 06:00 UTC by Celery Beat and emailed to admins.</p>
      {msg && <div className="toast static" role="status">{msg}</div>}
      {error && <div className="error" role="alert">{error}</div>}
      {reports === null && !error && <p className="muted">Loading…</p>}
      {reports?.map((r) => (
        <div key={r.id} className="panel">
          <div className="row between wrap gap">
            <strong>{r.data.period_start ? `${day(r.data.period_start)} – ${day(r.data.period_end)}` : "Weekly summary"}</strong>
            <span className="muted small">generated {new Date(r.created_at).toLocaleString()}</span>
          </div>
          <div className="stats">
            <Stat label="Created (7d)" value={r.data.created} />
            <Stat label="Completed (7d)" value={r.data.completed} />
            <Stat label="Open" value={r.data.open_total} />
            <Stat label="Overdue" value={r.data.overdue} hot={r.data.overdue > 0} />
          </div>
          {r.data.open_by_assignee?.length > 0 && (
            <div className="small">Open by assignee: {r.data.open_by_assignee.map((a) => `${a.assignee__email ?? "unassigned"} (${a.open})`).join(", ")}</div>
          )}
        </div>
      ))}
      {reports?.length === 0 && <p className="muted">No reports yet.{can(role, "admin") ? " Use Generate now to create the first one." : ""}</p>}
    </div>
  );
}

const Stat = ({ label, value, hot }) => (
  <div className="stat"><div className={`stat-value ${hot ? "danger-text" : ""}`}>{value}</div><div className="muted small">{label}</div></div>
);
