const TYPE_ICON = { bug: "🐞", story: "📗", task: "✅", epic: "⚡" };

export default function IssueCard({ issue, onClick }) {
  return (
    <div className="card" onClick={onClick}>
      <div className="card-title">{issue.title}</div>
      <div className="row between small">
        <span>
          <span title={issue.type}>{TYPE_ICON[issue.type]}</span>{" "}
          <span className="muted">{issue.key}</span>
        </span>
        <span className="row gap">
          <span className={`prio prio-${issue.priority}`} title={`Priority: ${issue.priority}`}>{issue.priority}</span>
          {issue.story_points != null && <span className="badge">{issue.story_points}</span>}
          {issue.comment_count > 0 && <span className="muted">💬 {issue.comment_count}</span>}
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
