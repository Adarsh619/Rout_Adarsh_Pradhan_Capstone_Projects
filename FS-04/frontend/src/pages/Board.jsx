import { useCallback, useEffect, useRef, useState } from "react";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { canTransition, dropPosition, moveCard } from "../boardLogic";
import IssueCard from "../components/IssueCard";
import IssueModal from "../components/IssueModal";
import { can, useWorkspace } from "../workspace";

export const SEARCH_DELAY_MS = 300;

export default function Board() {
  const { slug, projectId } = useParams();
  const { projects, role, members, reloadProjects } = useWorkspace();
  const project = projects.find((p) => String(p.id) === projectId);
  // Filters and the open issue live in the URL, so a reload or a shared link shows the same board.
  const [params, setParams] = useSearchParams();
  const sprintFilter = params.get("sprint") || "all";
  const assignee = params.get("assignee") || "";
  const q = params.get("q") || "";
  const openIssue = params.get("issue");
  const [search, setSearch] = useState(q);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [sprints, setSprints] = useState([]);
  const [dragFrom, setDragFrom] = useState(null);
  const [toast, setToast] = useState("");
  const [creating, setCreating] = useState(null); // status id for a new issue
  const latest = useRef(0);
  const toastTimer = useRef(null);

  const setParam = useCallback((key, value) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace: key !== "issue" });
  }, [setParams]);

  const boardId = project?.board_id;
  const load = useCallback(async () => {
    if (!boardId) return;
    const request = ++latest.current; // only the newest request may update the board
    const qs = new URLSearchParams({ sprint: sprintFilter });
    if (assignee) qs.set("assignee", assignee);
    if (q) qs.set("q", q);
    try {
      const board = await api.get(`/boards/${boardId}/columns/?${qs}`);
      if (request === latest.current) { setData(board); setLoadError(""); }
    } catch (err) {
      if (request === latest.current) setLoadError(err.message);
    }
  }, [boardId, sprintFilter, assignee, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.list(`/sprints/?project=${projectId}`).then(setSprints).catch(() => {}); }, [projectId]);
  // Search waits until typing pauses, instead of one request per key.
  useEffect(() => {
    if (search === q) return;
    const id = setTimeout(() => setParam("q", search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(id);
  }, [search, q, setParam]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const flash = (msg) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(""), 3500);
  };

  const onDragEnd = async ({ source, destination, draggableId }) => {
    setDragFrom(null);
    if (!destination) return;
    if (source.droppableId === destination.droppableId && source.index === destination.index) return;
    const from = Number(source.droppableId), to = Number(destination.droppableId);
    if (!canTransition(data.transitions, from, to)) {
      flash("That move isn't allowed by this project's workflow.");
      return;
    }
    const previous = data;
    const columns = moveCard(data.columns, source, destination);
    setData({ ...data, columns }); // optimistic
    try {
      await api.post(`/issues/${draggableId}/move/`, { status: to, ...dropPosition(columns, destination) });
    } catch (err) {
      setData(previous);
      flash(err.message);
    }
  };

  const onSaved = () => { load(); reloadProjects(); };
  const filtered = q || assignee || sprintFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setParams((p) => { const next = new URLSearchParams(); if (p.get("issue")) next.set("issue", p.get("issue")); return next; }, { replace: true });
  };

  if (!project) {
    return (
      <div className="center empty-state">
        <h2>Project not found</h2>
        <p className="muted">It may have been deleted.</p>
        <Link className="button primary" to={`/w/${slug}`}>All projects</Link>
      </div>
    );
  }
  const editable = can(role, "member");
  const statuses = data?.columns.map((c) => c.status) ?? [];
  const total = data?.columns.reduce((n, c) => n + c.issues.length, 0) ?? 0;

  return (
    <div className="board-page">
      <div className="row between wrap gap">
        <div>
          <h2>{project.name} <span className="badge">{project.key}</span></h2>
          {data?.active_sprint && <div className="muted small">Active sprint: <strong>{data.active_sprint.name}</strong> {data.active_sprint.goal && `— ${data.active_sprint.goal}`}</div>}
        </div>
        <div className="row gap">
          <Link to={`/w/${slug}/p/${projectId}/sprints`} className="button">Backlog & sprints</Link>
          {editable && <button className="primary" disabled={!data} onClick={() => setCreating(statuses[0]?.id)}>+ Issue</button>}
        </div>
      </div>

      <div className="filters row gap">
        <input type="search" aria-label="Search issues" placeholder="Search issues…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Sprint" value={sprintFilter} onChange={(e) => setParam("sprint", e.target.value === "all" ? "" : e.target.value)}>
          <option value="all">All issues</option>
          <option value="active">Active sprint</option>
          <option value="backlog">Backlog only</option>
          {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.state})</option>)}
        </select>
        <select aria-label="Assignee" value={assignee} onChange={(e) => setParam("assignee", e.target.value)}>
          <option value="">Everyone</option>
          {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.display_name}</option>)}
        </select>
        {filtered && <>
          <span className="muted small">{total} matching</span>
          <button className="link" onClick={clearFilters}>Clear filters</button>
        </>}
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}
      {loadError && (
        <div className="error row between" role="alert">{loadError}<button className="link" onClick={load}>Try again</button></div>
      )}

      {!data ? (!loadError && <p className="muted">Loading board…</p>) : (
        <DragDropContext onDragStart={(s) => setDragFrom(Number(s.source.droppableId))} onDragEnd={onDragEnd}>
          <div className="columns">
            {data.columns.map((col) => {
              const blocked = dragFrom != null && !canTransition(data.transitions, dragFrom, col.status.id);
              const done = col.status.category === "done";
              return (
                <Droppable droppableId={String(col.status.id)} key={col.status.id} isDropDisabled={!editable || blocked}>
                  {(provided, snapshot) => (
                    <div className={`column ${snapshot.isDraggingOver ? "over" : ""} ${blocked ? "blocked" : ""}`}
                      ref={provided.innerRef} {...provided.droppableProps}>
                      <div className="column-head" style={{ borderTopColor: col.status.color }}>
                        <span>{col.status.name}</span><span className="muted">{col.issues.length}</span>
                      </div>
                      {blocked && <div className="column-note">Not allowed from here</div>}
                      {col.issues.map((issue, index) => (
                        <Draggable draggableId={String(issue.id)} index={index} key={issue.id} isDragDisabled={!editable}>
                          {(p) => (
                            <div ref={p.innerRef} {...p.draggableProps} {...p.dragHandleProps}
                              tabIndex={0} aria-label={`${issue.key} ${issue.title}`}
                              onKeyDown={(e) => {
                                p.dragHandleProps?.onKeyDown?.(e);
                                if (e.key === "Enter" && !e.defaultPrevented) setParam("issue", String(issue.id));
                              }}>
                              <IssueCard issue={issue} done={done} onClick={() => setParam("issue", String(issue.id))} />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                      {col.issues.length === 0 && !snapshot.isDraggingOver && (
                        <div className="column-empty">{filtered ? "No matching issues" : "No issues"}</div>
                      )}
                      {editable && <button className="ghost add-card" onClick={() => setCreating(col.status.id)}>+ Add</button>}
                    </div>
                  )}
                </Droppable>
              );
            })}
          </div>
        </DragDropContext>
      )}

      {(openIssue || creating) && (
        <IssueModal
          issueId={openIssue ? Number(openIssue) : undefined}
          defaultStatus={creating}
          projectId={projectId}
          statuses={statuses}
          transitions={data?.transitions}
          sprints={sprints}
          onClose={() => { setCreating(null); if (openIssue) setParam("issue", ""); }}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}
