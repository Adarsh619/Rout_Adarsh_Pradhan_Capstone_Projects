import { useEffect, useState } from "react";
import { canTransition } from "../boardLogic";
import { api, download, formatError } from "../api";
import { formatChanges } from "../auditFormat";
import { can, useWorkspace } from "../workspace";
import DeleteIssueControls from "./DeleteIssueControls";
import Modal from "./Modal";

const EMPTY = { title: "", description: "", type: "task", priority: "medium", assignee: "", story_points: "", due_date: "", sprint: "" };
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // the API's attachment limit

const formFrom = (i) => ({
  title: i.title, description: i.description, type: i.type, priority: i.priority, status: i.status,
  assignee: i.assignee ?? "", story_points: i.story_points ?? "", due_date: i.due_date ?? "", sprint: i.sprint ?? "",
});

export default function IssueModal({ issueId, projectId, statuses = [], transitions, sprints = [], defaultStatus, onClose, onSaved }) {
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
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [initial, setInitial] = useState(null); // the form as loaded, to spot unsaved edits

  useEffect(() => {
    if (!issueId) {
      const blank = { ...EMPTY, status: defaultStatus || "" };
      setForm(blank);
      setInitial(blank);
      return;
    }
    let active = true;
    setLoadError("");
    api.get(`/issues/${issueId}/`).then((i) => {
      if (!active) return;
      setIssue(i);
      setForm(formFrom(i));
      setInitial(formFrom(i));
    }).catch((err) => active && setLoadError(err.status === 404 ? "This issue doesn't exist any more. It may have been deleted." : err.message));
    api.list(`/comments/?issue=${issueId}`).then((c) => active && setComments(c)).catch(() => {});
    api.list(`/attachments/?issue=${issueId}`).then((a) => active && setAttachments(a)).catch(() => {});
    api.get(`/issues/${issueId}/history/`).then((h) => active && setHistory(h)).catch(() => {});
    return () => { active = false; };
  }, [issueId, defaultStatus]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const dirty = editable && initial !== null && JSON.stringify(form) !== JSON.stringify(initial);
  // Closing with Escape, the backdrop or the close button asks first when there are unsaved edits.
  const close = () => {
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    onClose();
  };
  // The status list offers only moves the workflow allows from the issue's saved status.
  const statusOptions = issue && transitions
    ? statuses.filter((s) => canTransition(transitions, issue.status, s.id))
    : statuses;

  const save = async (e) => {
    e.preventDefault();
    if (saving) return;
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
    setSaving(true);
    try {
      const saved = issueId ? await api.patch(`/issues/${issueId}/`, body) : await api.post("/issues/", body);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err.status === 402 ? `${err.message} See Billing to upgrade.` : err.message);
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete ${issue.key}? Its comments and attachments are deleted too. This can't be undone.`)) return;
    try {
      await api.del(`/issues/${issueId}/`);
      onSaved?.();
      onClose();
    } catch (err) { setError(err.message); }
  };
  const requestDeletion = () => api.post(`/issues/${issueId}/request_deletion/`);
  // A reporter who has left the workspace can't delete anything any more, so only admins are named then.
  const reporter = issue?.reporter_detail;
  const reporterName = reporter && members.some((m) => m.user.id === reporter.id) ? reporter.display_name : null;

  const addComment = async (e) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setError("");
    try {
      const c = await api.post("/comments/", { issue: issueId, body: comment });
      setComments([...comments, c]);
      setComment("");
    } catch (err) { setError(err.message); }
  };
  const deleteComment = async (c) => {
    if (!window.confirm("Delete this comment?")) return;
    setError("");
    try { await api.del(`/comments/${c.id}/`); setComments(comments.filter((x) => x.id !== c.id)); }
    catch (err) { setError(err.message); }
  };

  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setError("");
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(`${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Attachments can be up to 10 MB.`);
      e.target.value = "";
      return;
    }
    const fd = new FormData();
    fd.append("issue", issueId);
    fd.append("file", file);
    try { setAttachments([await api.post("/attachments/", fd), ...attachments]); }
    catch (err) { setError(formatError(err.data) || err.message); }
    e.target.value = "";
  };

  return (
    <Modal title={issue ? `${issue.key} · ${issue.title}` : issueId ? "Issue" : "Create issue"} onClose={close} wide>
      {loadError ? (
        <div className="stack">
          <div className="error" role="alert">{loadError}</div>
          <div><button onClick={onClose}>Close</button></div>
        </div>
      ) : issueId && !issue ? <p className="muted">Loading issue…</p> : <>
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
              {statusOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
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
        {error && <div className="error" role="alert">{error}</div>}
        {editable && (
          <div className="row between gap wrap issue-footer">
            <div>
              {issue && (
                <DeleteIssueControls canDelete={issue.can_delete} issueKey={issue.key} reporterName={reporterName}
                  onDelete={remove} onRequest={requestDeletion} />
              )}
            </div>
            <span className="row gap">
              {dirty && <span className="muted small">Unsaved changes</span>}
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "Saving…" : issueId ? "Save changes" : "Create issue"}
              </button>
            </span>
          </div>
        )}
      </form>

      {issueId && (
        <div className="issue-tabs">
          <div className="tabs">
            {["comments", "attachments", "history"].map((t) => (
              <button key={t} type="button" className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
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
                      <button className="link small" onClick={() => deleteComment(c)}>delete</button>
                    )}
                  </div>
                  <div className="pre">{c.body}</div>
                </div>
              ))}
              {editable && (
                <form onSubmit={addComment} className="row gap">
                  <input aria-label="Comment" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} style={{ flex: 1 }} />
                  <button className="primary">Comment</button>
                </form>
              )}
            </div>
          )}
          {tab === "attachments" && (
            <div className="stack">
              {editable && <label className="small">Attach a file (up to 10 MB)<input type="file" onChange={upload} /></label>}
              {attachments.length === 0 && <p className="muted small">No attachments.</p>}
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
              {history.length === 0 && <li className="muted small">No history yet.</li>}
              {history.map((h) => (
                <li key={h.id}>
                  <span className="muted small">{new Date(h.created_at).toLocaleString()}</span>{" "}
                  <strong>{h.actor_email || "system"}</strong> {h.action.split(".")[1].replaceAll("_", " ")}{" "}
                  {formatChanges(h.changes).map((c) => (
                    <span key={c.label} className="small">· {c.label}: {c.text} </span>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      </>}
    </Modal>
  );
}
