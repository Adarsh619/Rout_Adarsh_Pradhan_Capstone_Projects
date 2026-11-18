// How each kind of row appears in the audit log: its type name (v1's model names, which the web app and the
// issue History tab use) and a human-readable label.

export interface Entity {
  type: string;
  id: number;
  label: string;
}

const cut = (s: string) => s.slice(0, 255);

export const entity = {
  workspace: (w: { id: number; name: string }): Entity => ({ type: "workspace", id: w.id, label: cut(w.name) }),
  membership: (m: { id: number; role: string }, email: string, workspaceName: string): Entity => ({
    type: "membership",
    id: m.id,
    label: cut(`${email} @ ${workspaceName} (${m.role})`),
  }),
  workflow: (w: { id: number; name: string }): Entity => ({ type: "workflow", id: w.id, label: cut(w.name) }),
  status: (s: { id: number; name: string }): Entity => ({ type: "workflowstatus", id: s.id, label: cut(s.name) }),
  transition: (t: { id: number }, from: string, to: string): Entity => ({
    type: "workflowtransition",
    id: t.id,
    label: cut(`${from} → ${to}`),
  }),
  project: (p: { id: number; key: string; name: string }): Entity => ({
    type: "project",
    id: p.id,
    label: cut(`${p.key} — ${p.name}`),
  }),
  board: (b: { id: number; name: string }): Entity => ({ type: "board", id: b.id, label: cut(b.name) }),
  sprint: (s: { id: number; name: string }): Entity => ({ type: "sprint", id: s.id, label: cut(s.name) }),
  issue: (i: { id: number; number: number; title: string }, projectKey: string): Entity => ({
    type: "issue",
    id: i.id,
    label: cut(`${projectKey}-${i.number} ${i.title}`),
  }),
  comment: (c: { id: number; issueId: number }): Entity => ({
    type: "comment",
    id: c.id,
    label: cut(`Comment ${c.id} on issue ${c.issueId}`),
  }),
  attachment: (a: { id: number; filename: string }): Entity => ({ type: "attachment", id: a.id, label: cut(a.filename) }),
  webhook: (h: { id: number; url: string }): Entity => ({ type: "webhook", id: h.id, label: cut(h.url) }),
  subscription: (s: { id: number; plan: string; status: string }, workspaceName: string): Entity => ({
    type: "subscription",
    id: s.id,
    label: cut(`${workspaceName} – ${s.plan} (${s.status})`),
  }),
};
