import type {
  Attachment,
  Board,
  Comment,
  Issue,
  Membership,
  Project,
  Sprint,
  User,
  Workflow,
  WorkflowStatus,
  WorkflowTransition,
} from "../../generated/prisma/client.js";
import { day, iso } from "../../lib/http.js";
import { userOrNull } from "../auth/serialize.js";
import { hasRole } from "../tenancy/context.js";

// API shapes for the tracker, field for field as v1 sent them.

export const statusOut = (s: WorkflowStatus) => ({
  id: s.id,
  workflow: s.workflowId,
  name: s.name,
  category: s.category,
  color: s.color,
  order: s.order,
});

export const transitionOut = (t: WorkflowTransition) => ({
  id: t.id,
  workflow: t.workflowId,
  from_status: t.fromStatusId,
  to_status: t.toStatusId,
});

export const workflowOut = (w: Workflow & { statuses: WorkflowStatus[]; transitions: WorkflowTransition[] }) => ({
  id: w.id,
  name: w.name,
  is_default: w.isDefault,
  statuses: [...w.statuses].sort((a, b) => a.order - b.order || a.id - b.id).map(statusOut),
  transitions: [...w.transitions].sort((a, b) => a.id - b.id).map(transitionOut),
  created_at: iso(w.createdAt),
});

export const projectOut = (p: Project & { _count?: { issues: number }; boards?: Array<{ id: number }> }) => ({
  id: p.id,
  key: p.key,
  name: p.name,
  description: p.description,
  workflow: p.workflowId,
  lead: p.leadId,
  issue_count: p._count?.issues ?? 0,
  board_id: p.boards?.length ? Math.min(...p.boards.map((b) => b.id)) : null,
  created_at: iso(p.createdAt),
});

export const boardOut = (b: Board) => ({
  id: b.id,
  project: b.projectId,
  name: b.name,
  kind: b.kind,
  created_at: iso(b.createdAt),
});

export const sprintOut = (s: Sprint & { _count?: { issues: number } }) => ({
  id: s.id,
  project: s.projectId,
  name: s.name,
  goal: s.goal,
  start_date: day(s.startDate),
  end_date: day(s.endDate),
  state: s.state,
  issue_count: s._count?.issues ?? 0,
  created_at: iso(s.createdAt),
});

// What an issue row needs loaded to be serialized.
export const issueInclude = {
  project: { select: { key: true } },
  status: true,
  assignee: true,
  reporter: true,
  _count: { select: { comments: true } },
} as const;

export type IssueRow = Issue & {
  project: { key: string };
  status: WorkflowStatus;
  assignee: User | null;
  reporter: User | null;
  _count: { comments: number };
};

// The reporter or an admin/owner may delete an issue, the same rule as comments and attachments.
export function canDeleteIssue(issue: Pick<Issue, "reporterId">, membership: Pick<Membership, "role" | "userId"> | undefined) {
  if (!membership) return false;
  return hasRole(membership, "admin") || (hasRole(membership, "member") && issue.reporterId === membership.userId);
}

export const issueKey = (i: { number: number; project: { key: string } }) => `${i.project.key}-${i.number}`;

export const issueOut = (i: IssueRow, membership?: Pick<Membership, "role" | "userId">) => ({
  id: i.id,
  key: issueKey(i),
  number: i.number,
  project: i.projectId,
  title: i.title,
  description: i.description,
  type: i.type,
  priority: i.priority,
  status: i.statusId,
  status_name: i.status.name,
  status_category: i.status.category,
  sprint: i.sprintId,
  assignee: i.assigneeId,
  assignee_detail: userOrNull(i.assignee),
  reporter_detail: userOrNull(i.reporter),
  story_points: i.storyPoints,
  due_date: day(i.dueDate),
  rank: i.rank,
  comment_count: i._count.comments,
  can_delete: canDeleteIssue(i, membership),
  created_at: iso(i.createdAt),
  updated_at: iso(i.updatedAt),
});

export const commentOut = (c: Comment & { author: User | null }) => ({
  id: c.id,
  issue: c.issueId,
  author: userOrNull(c.author),
  body: c.body,
  created_at: iso(c.createdAt),
  updated_at: iso(c.updatedAt),
});

// Files are never served publicly; downloads go through the tenant-checked API.
export const attachmentOut = (a: Attachment & { uploadedBy: User | null }) => ({
  id: a.id,
  issue: a.issueId,
  filename: a.filename,
  size: a.size,
  uploaded_by: userOrNull(a.uploadedBy),
  download_url: `/api/attachments/${a.id}/download/`,
  created_at: iso(a.createdAt),
});
