// The shapes the TaskFlow API sends (see docs/openapi.yaml). Field names are the API's (snake_case).

export type Role = "owner" | "admin" | "member" | "viewer";
export type PlanId = "free" | "pro" | "business";
export type StatusCategory = "todo" | "in_progress" | "done";
export type IssueType = "task" | "bug" | "story" | "epic";
export type Priority = "low" | "medium" | "high" | "critical";
export type SprintState = "planned" | "active" | "closed";

export interface User {
  id: number;
  email: string;
  full_name: string;
  display_name: string;
}

// The signed-in user (/auth/me/), with what the app needs to know about the public demo.
export interface Me extends User {
  demo_mode: boolean;
  is_demo_account: boolean;
}

export interface Workspace {
  id: number;
  name: string;
  slug: string;
  created_at: string;
  role: Role;
  plan: PlanId;
}

export interface Member {
  id: number;
  user: User;
  role: Role;
  joined_at: string;
}

export interface Status {
  id: number;
  workflow: number;
  name: string;
  category: StatusCategory;
  color: string;
  order: number;
}

export interface Transition {
  id?: number;
  workflow?: number;
  from_status: number;
  to_status: number;
}

export interface Workflow {
  id: number;
  name: string;
  is_default: boolean;
  statuses: Status[];
  transitions: Transition[];
  created_at: string;
}

export interface Project {
  id: number;
  key: string;
  name: string;
  description: string;
  workflow: number;
  lead: number | null;
  issue_count: number;
  board_id: number | null;
  created_at: string;
}

export interface Board {
  id: number;
  project: number;
  name: string;
  kind: "kanban" | "scrum";
  created_at: string;
}

export interface Sprint {
  id: number;
  project: number;
  name: string;
  goal: string;
  start_date: string | null;
  end_date: string | null;
  state: SprintState;
  issue_count: number;
  created_at: string;
}

export interface Issue {
  id: number;
  key: string;
  number: number;
  project: number;
  title: string;
  description: string;
  type: IssueType;
  priority: Priority;
  status: number;
  status_name: string;
  status_category: StatusCategory;
  sprint: number | null;
  assignee: number | null;
  assignee_detail: User | null;
  reporter_detail: User | null;
  story_points: number | null;
  due_date: string | null;
  rank: number;
  comment_count: number;
  can_delete: boolean;
  created_at: string;
  updated_at: string;
}

export interface Column {
  status: Status;
  issues: Issue[];
}

export interface BoardView {
  board: Board;
  project: Pick<Project, "id" | "key" | "name">;
  active_sprint: Sprint | null;
  transitions: Transition[];
  columns: Column[];
}

export interface Comment {
  id: number;
  issue: number;
  author: User | null;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: number;
  issue: number;
  filename: string;
  size: number;
  uploaded_by: User | null;
  download_url: string;
  created_at: string;
}

export type Changes = Record<string, unknown>;

export interface AuditEntry {
  id: number;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  changes: Changes;
  actor_email: string;
  created_at: string;
  ip_address?: string | null;
}

export interface Webhook {
  id: number;
  url: string;
  events: string[];
  secret: string;
  is_active: boolean;
  created_at: string;
}

export interface WebhookDelivery {
  id: number;
  webhook: number;
  event: string;
  payload: unknown;
  status_code: number | null;
  response_body: string;
  success: boolean;
  attempts: number;
  created_at: string;
  delivered_at: string | null;
}

export interface Notification {
  id: number;
  verb: string;
  message: string;
  issue: number | null;
  issue_key: string | null;
  project: number | null;
  read: boolean;
  created_at: string;
}

export interface WeeklyReport {
  period_start: string;
  period_end: string;
  created: number;
  completed: number;
  open_total: number;
  overdue: number;
  open_by_assignee: Array<{ open: number; assignee__email: string | null }>;
}

export interface Report {
  id: number;
  kind: string;
  data: WeeklyReport;
  created_at: string;
}

export type Limits = Record<"projects" | "members" | "issues", number | null>;

export interface Plan {
  name: string;
  price_usd: number;
  limits: Limits;
}

export interface BillingOverview {
  plan: PlanId;
  effective_plan: PlanId;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  limits: Limits;
  usage: Record<"projects" | "members" | "issues", number>;
  plans: Record<PlanId, Plan>;
  mode: "mock" | "live" | "disabled";
  stripe_enabled: boolean;
  has_subscription: boolean;
  can_manage: boolean;
}

export interface Page<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

export interface TokenPair {
  access: string;
  refresh: string;
}
