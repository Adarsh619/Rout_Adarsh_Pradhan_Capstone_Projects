import type { User } from "../../generated/prisma/client.js";
import type { Tx, Unit } from "../../lib/db.js";
import { day } from "../../lib/http.js";
import { enqueue } from "../../jobs/queue.js";
import { displayName } from "../auth/serialize.js";

// In-app notifications (the bell) plus an email for each, sent by the worker.

export const MESSAGES = {
  assigned: "{actor} assigned you {key}: {title}",
  commented: "{actor} commented on {key}: {title}",
  moved: "{actor} moved {key} to {status}",
  due_soon: "{key} is due on {due}: {title}",
  delete_requested: "{actor} asked to delete {key}: {title}",
} as const;

export type Verb = keyof typeof MESSAGES;

export interface IssueForNote {
  id: number;
  workspaceId: number;
  number: number;
  title: string;
  dueDate: Date | null;
  assigneeId: number | null;
  reporterId: number | null;
  project: { key: string };
  status: { name: string };
}

export function message(verb: Verb, issue: IssueForNote, actor: Pick<User, "email" | "fullName"> | null): string {
  const values: Record<string, string> = {
    actor: actor ? displayName({ id: 0, ...actor }) : "TaskFlow",
    key: `${issue.project.key}-${issue.number}`,
    title: issue.title.slice(0, 120),
    status: issue.status.name,
    due: day(issue.dueDate) ?? "None",
  };
  return MESSAGES[verb].replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? "").slice(0, 255);
}

async function send(unit: Unit, issue: IssueForNote, verb: Verb, actor: User | null, recipients: Set<number>) {
  if (!recipients.size) return [];
  const text = message(verb, issue, actor);
  const notes = await unit.tx.notification.createManyAndReturn({
    data: [...recipients].map((userId) => ({
      workspaceId: issue.workspaceId, userId, actorId: actor?.id ?? null, verb, issueId: issue.id, message: text,
    })),
    select: { id: true },
  });
  const ids = notes.map((n) => n.id);
  unit.after(() => enqueue("send_notification_emails", { ids }));
  return notes;
}

async function members(tx: Tx, workspaceId: number, userIds: number[]) {
  const rows = await tx.membership.findMany({ where: { workspaceId, userId: { in: userIds } }, select: { userId: true } });
  return new Set(rows.map((r) => r.userId));
}

// Notify the people involved in an issue (its assignee and reporter; only the assignee for "assigned"),
// never the person who acted, and never someone who has left the workspace.
export async function notifyIssueEvent(unit: Unit, issue: IssueForNote, verb: Verb, actor: User | null = null) {
  const ids = new Set(verb === "assigned" ? [issue.assigneeId] : [issue.assigneeId, issue.reporterId]);
  ids.delete(null);
  if (actor) ids.delete(actor.id);
  const recipients = ids.size ? await members(unit.tx, issue.workspaceId, [...ids] as number[]) : new Set<number>();
  return send(unit, issue, verb, actor, recipients);
}

// Notify the workspace's admins and owner (e.g. a member asking for an issue to be deleted).
export async function notifyWorkspaceAdmins(unit: Unit, issue: IssueForNote, verb: Verb, actor: User | null = null) {
  const rows = await unit.tx.membership.findMany({
    where: { workspaceId: issue.workspaceId, role: { in: ["admin", "owner"] } },
    select: { userId: true },
  });
  const recipients = new Set(rows.map((r) => r.userId));
  if (actor) recipients.delete(actor.id);
  return send(unit, issue, verb, actor, recipients);
}
