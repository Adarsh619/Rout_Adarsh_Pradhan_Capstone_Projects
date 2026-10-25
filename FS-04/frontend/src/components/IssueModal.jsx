import { useEffect, useState } from "react";
import { api, download, formatError } from "../api";
import { can, useWorkspace } from "../workspace";
import Modal from "./Modal";

const EMPTY = { title: "", description: "", type: "task", priority: "medium", assignee: "", story_points: "", due_date: "", sprint: "" };

export default function IssueModal({ issueId, projectId, statuses = [], sprints = [], defaultStatus, onClose, onSaved }) {
  const { members, role, user } = useWorkspace();
  const editable = can(role, "member");
  const [issue, setIssue] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [comments, setComments] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [history, setHistory] = useState([]);
  const [tab, setTab] = useState("comments");
  const [comment, setComment] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!issueId) { setForm({ ...EMPTY, status: defaultStatus || "" }); return; }
    api.get(`/issues/${issueId}/`).then((i) => {
      setIssue(i);
      setForm({
        title: i.title, description: i.description, type: i.type, priority: i.priority, status: i.status,
        assignee: i.assignee ?? "", story_points: i.story_points ?? "", due_date: i.due_date ?? "", sprint: i.sprint ?? "",
      });
    });
    api.list(`/comments/?issue=${issueId}`).then(setComments);
    api.list(`/attachments/?issue=${issueId}`).then(setAttachments);
    api.get(`/issues/${issueId}/history/`).then(setHistory);
  }, [issueId, defaultStatus]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async (e) => {
    e.preventDefault();
    setError("");
    const body = {
      ...form,
      project: Number(projectId),
      assignee: form.assignee ? Number(form.assignee) : null,
      sprint: form.sprint ? Number(form.sprint) : null,
      story_points: form.story_points === "" ? null : Number(form.story_points),
      due_date: form.due_date || null,
    };
    if (form.status) body.status = Number(form.status); else delete body.status;
    try {
      const saved = issueId ? await api.patch(`/issues/${issueId}/`, body) : await api.post("/issues/", body);
      onSaved?.(saved);
      onClose();
    } catch (err) { setError(err.message); }
  };

  const remove = async () => {
    if (!window.confirm("Delete this issue?")) return;
    await api.del(`/issues/${issueId}/`);
    onSaved?.();
    onClose();
  };

  const addComment = async (e) => {
    e.preventDefault();
    if (!comment.trim()) return;
    const c = await api.post("/comments/", { issue: issueId, body: comment });
    setComments([...comments, c]);
    setComment("");
  };

  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("issue", issueId);
    fd.append("file", file);
    try { setAttachments([await api.post("/attachments/", fd), ...attachments]); }
    catch (err) { setError(formatError(err.data) || err.message); }
    e.target.value = "";
  };

  return (
    <Modal title={issue ? `${issue.key} · ${issue.title}` : "Create issue"} onClose={onClose} wide>
      <form onSubmit={save} className="issue-form">
        <div className="grid-2">
          <div className="stack">
            <label>Title<input required value={form.title} onChange={set("title")} disabled={!editable} /></label>
            <label>Description<textarea rows={6} value={form.description} onChange={set("description")} disabled={!editable} /></label>
          </div>
          <div className="stack">
            <div className="grid-2">
              <label>Type<select value={form.type} onChange={set("type")} disabled={!editable}>
                {["task", "bug", "story", "epic"].map((t) => <option key={t}>{t}</option>)}</select></label>
              <label>Priority<select value={form.priority} onChange={set("priority")} disabled={!editable}>
                {["low", "medium", "high", "critical"].map((t) => <option key={t}>{t}</option>)}</select></label>
            </div>
            <label>Status<select value={form.status ?? ""} onChange={set("status")} disabled={!editable}>
              {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <label>Assignee<select value={form.assignee} onChange={set("assignee")} disabled={!editable}>
              <option value="">Unassigned</option>
              {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.display_name}</option>)}</select></label>
            <label>Sprint<select value={form.sprint} onChange={set("sprint")} disabled={!editable}>
              <option value="">Backlog</option>
              {sprints.filter((s) => s.state !== "closed").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
            <div className="grid-2">
              <label>Story points<input type="number" min="0" value={form.story_points} onChange={set("story_points")} disabled={!editable} /></label>
              <label>Due date<input type="date" value={form.due_date} onChange={set("due_date")} disabled={!editable} /></label>
            </div>
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        {editable && (
          <div className="row between">
            <div>{issueId && <button type="button" className="danger" onClick={remove}>Delete</button>}</div>
            <button type="submit" className="primary">{issueId ? "Save changes" : "Create issue"}</button>
          </div>
        )}
      </form>

      {issueId && (
        <div className="issue-tabs">
          <div className="tabs">
            {["comments", "attachments", "history"].map((t) => (
              <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
                {t} {t === "comments" ? `(${comments.length})` : t === "attachments" ? `(${attachments.length})` : ""}
              </button>
            ))}
          </div>
          {tab === "comments" && (
            <div className="stack">
              {comments.map((c) => (
                <div key={c.id} className="comment">
                  <div className="small"><strong>{c.author?.display_name}</strong> <span className="muted">{new Date(c.created_at).toLocaleString()}</span>
                    {(c.author?.id === user.id || can(role, "admin")) && (
                      <button className="link small" onClick={async () => { await api.del(`/comments/${c.id}/`); setComments(comments.filter((x) => x.id !== c.id)); }}>delete</button>
                    )}
                  </div>
                  <div className="pre">{c.body}</div>
                </div>
              ))}
              {editable && (
                <form onSubmit={addComment} className="row gap">
                  <input placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: 1 }} />
                  <button className="primary">Comment</button>
                </form>
              )}
            </div>
          )}
          {tab === "attachments" && (
            <div className="stack">
              {editable && <input type="file" onChange={upload} />}
              {attachments.map((a) => (
                <div key={a.id} className="row between attachment">
                  <button className="link" onClick={() => download(a.download_url, a.filename)}>📎 {a.filename}</button>
                  <span className="muted small">{(a.size / 1024).toFixed(1)} KB · {a.uploaded_by?.display_name}</span>
                </div>
              ))}
            </div>
          )}
          {tab === "history" && (
            <ul className="history">
              {history.map((h) => (
                <li key={h.id}>
                  <span className="muted small">{new Date(h.created_at).toLocaleString()}</span>{" "}
                  <strong>{h.actor_email}</strong> {h.action.split(".")[1]}{" "}
                  {Object.entries(h.changes || {}).map(([k, v]) => (
                    <span key={k} className="small">· {k}: {Array.isArray(v) ? `${v[0] ?? "—"} → ${v[1] ?? "—"}` : String(v)} </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Modal>
  );
}
