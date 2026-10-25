import { useCallback, useEffect, useState } from "react";
import { DragDropContext, Draggable, Droppable } from "@hello-pangea/dnd";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { canTransition, moveCard } from "../boardLogic";
import IssueCard from "../components/IssueCard";
import IssueModal from "../components/IssueModal";
import { can, useWorkspace } from "../workspace";

export default function Board() {
  const { slug, projectId } = useParams();
  const { projects, role, members } = useWorkspace();
  const project = projects.find((p) => String(p.id) === projectId);
  const [params, setParams] = useSearchParams();
  const [data, setData] = useState(null);
  const [sprints, setSprints] = useState([]);
  const [sprintFilter, setSprintFilter] = useState("all");
  const [assignee, setAssignee] = useState("");
  const [q, setQ] = useState("");
  const [dragFrom, setDragFrom] = useState(null);
  const [toast, setToast] = useState("");
  const [modal, setModal] = useState(null); // {issueId} | {create: statusId}

  const boardId = project?.board_id;
  const load = useCallback(async () => {
    if (!boardId) return;
    const qs = new URLSearchParams({ sprint: sprintFilter });
    if (assignee) qs.set("assignee", assignee);
    if (q) qs.set("q", q);
    setData(await api.get(`/boards/${boardId}/columns/?${qs}`));
  }, [boardId, sprintFilter, assignee, q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.list(`/sprints/?project=${projectId}`).then(setSprints); }, [projectId]);
  useEffect(() => { const id = params.get("issue"); if (id) setModal({ issueId: Number(id) }); }, [params]);

  const flash = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3500); };

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
    setData({ ...data, columns: moveCard(data.columns, source, destination) }); // optimistic
    try {
      await api.post(`/issues/${draggableId}/move/`, { status: to, index: destination.index });
    } catch (err) {
      setData(previous);
      flash(err.message);
    }
  };

  if (!project) return <p className="muted">Loading project…</p>;
  const editable = can(role, "member");
  const statuses = data?.columns.map((c) => c.status) ?? [];

  return (
    <div className="board-page">
      <div className="row between">
        <div>
          <h2>{project.name} <span className="badge">{project.key}</span></h2>
          {data?.active_sprint && <div className="muted small">Active sprint: <strong>{data.active_sprint.name}</strong> {data.active_sprint.goal && `— ${data.active_sprint.goal}`}</div>}
        </div>
        <div className="row gap">
          <Link to={`/w/${slug}/p/${projectId}/sprints`} className="button">Backlog & sprints</Link>
          {editable && <button className="primary" onClick={() => setModal({ create: statuses[0]?.id })}>+ Issue</button>}
        </div>
      </div>

      <div className="filters row gap">
        <input placeholder="Search issues…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={sprintFilter} onChange={(e) => setSprintFilter(e.target.value)}>
          <option value="all">All issues</option>
          <option value="active">Active sprint</option>
          <option value="backlog">Backlog only</option>
          {sprints.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.state})</option>)}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">Everyone</option>
          {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.display_name}</option>)}
        </select>
      </div>

      {toast && <div className="toast">{toast}</div>}

      {!data ? <p className="muted">Loading board…</p> : (
        <DragDropContext onDragStart={(s) => setDragFrom(Number(s.source.droppableId))} onDragEnd={onDragEnd}>
          <div className="columns">
            {data.columns.map((col) => {
              const blocked = dragFrom != null && !canTransition(data.transitions, dragFrom, col.status.id);
              return (
                <Droppable droppableId={String(col.status.id)} key={col.status.id} isDropDisabled={!editable || blocked}>
                  {(provided, snapshot) => (
                    <div className={`column ${snapshot.isDraggingOver ? "over" : ""} ${blocked ? "blocked" : ""}`}
                      ref={provided.innerRef} {...provided.droppableProps}>
                      <div className="column-head" style={{ borderTopColor: col.status.color }}>
                        <span>{col.status.name}</span><span className="muted">{col.issues.length}</span>
                      </div>
                      {col.issues.map((issue, index) => (
                        <Draggable draggableId={String(issue.id)} index={index} key={issue.id} isDragDisabled={!editable}>
                          {(p) => (
                            <div ref={p.innerRef} {...p.draggableProps} {...p.dragHandleProps}>
                              <IssueCard issue={issue} onClick={() => setModal({ issueId: issue.id })} />
                            </div>
                          )}
                        </Draggable>
                      ))}
                      {provided.placeholder}
                      {editable && <button className="ghost add-card" onClick={() => setModal({ create: col.status.id })}>+ Add</button>}
                    </div>
                  )}
                </Droppable>
              );
            })}
          </div>
        </DragDropContext>
      )}

      {modal && (
        <IssueModal
          issueId={modal.issueId}
          defaultStatus={modal.create}
          projectId={projectId}
          statuses={statuses}
          sprints={sprints}
          onClose={() => { setModal(null); if (params.get("issue")) setParams({}); }}
          onSaved={load}
        />
      )}
    </div>
  );
}
