import { useEffect, useState } from "react";
import { api } from "../api";
import { can, useWorkspace } from "../workspace";

export default function Reports() {
  const { role } = useWorkspace();
  const [reports, setReports] = useState([]);
  const [msg, setMsg] = useState("");
  const load = () => api.list("/reports/").then(setReports);
  useEffect(() => { load(); }, []);
  const generate = async () => {
    const r = await api.post("/reports/generate/");
    setMsg(`Queued on the Celery worker (task ${r.task_id.slice(0, 8)}…). Refreshing shortly.`);
    setTimeout(() => { load(); setMsg(""); }, 2500);
  };
  return (
    <div className="stack">
      <div className="row between"><h2>Reports</h2>
        {can(role, "admin") && <button className="primary" onClick={generate}>Generate now</button>}</div>
      <p className="muted small">A weekly summary is generated every Monday 06:00 UTC by Celery Beat and emailed to admins.</p>
      {msg && <div className="toast static">{msg}</div>}
      {reports.map((r) => (
        <div key={r.id} className="panel">
          <div className="row between"><strong>Weekly summary</strong><span className="muted small">{new Date(r.created_at).toLocaleString()}</span></div>
          <div className="stats">
            <Stat label="Created (7d)" value={r.data.created} />
            <Stat label="Completed (7d)" value={r.data.completed} />
            <Stat label="Open" value={r.data.open_total} />
            <Stat label="Overdue" value={r.data.overdue} />
          </div>
          {r.data.open_by_assignee?.length > 0 && (
            <div className="small">Open by assignee: {r.data.open_by_assignee.map((a) => `${a.assignee__email ?? "unassigned"} (${a.open})`).join(", ")}</div>
          )}
        </div>
      ))}
      {reports.length === 0 && <p className="muted">No reports yet.</p>}
    </div>
  );
}

const Stat = ({ label, value }) => <div className="stat"><div className="stat-value">{value}</div><div className="muted small">{label}</div></div>;
