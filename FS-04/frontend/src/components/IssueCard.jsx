import { isOverdue } from "../boardLogic";

const TYPE_ICON = { bug: "🐞", story: "📗", task: "✅", epic: "⚡" };

const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

export default function IssueCard({ issue, onClick, done = false }) {
  const overdue = isOverdue(issue, done);
  return (
    <div className={`card ${overdue ? "overdue" : ""}`} onClick={onClick}>
      <div className="card-title">{issue.title}</div>
      <div className="row between small">
        <span>
          <span title={issue.type} aria-label={issue.type}>{TYPE_ICON[issue.type]}</span>{" "}
          <span className="muted">{issue.key}</span>
        </span>
        <span className="row gap">
          {issue.due_date && (
            <span className={`due ${overdue ? "late" : ""}`} title={overdue ? "Overdue" : "Due date"}>
              {overdue ? "⚠ " : ""}{shortDate(issue.due_date)}
            </span>
          )}
          <span className={`prio prio-${issue.priority}`} title={`Priority: ${issue.priority}`}>{issue.priority}</span>
          {issue.story_points != null && <span className="badge" title="Story points">{issue.story_points}</span>}
          {issue.comment_count > 0 && <span className="muted" title={`${issue.comment_count} comments`}>💬 {issue.comment_count}</span>}
          {issue.assignee_detail && (
            <span className="avatar" title={issue.assignee_detail.display_name}>
              {issue.assignee_detail.display_name.slice(0, 2).toUpperCase()}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
