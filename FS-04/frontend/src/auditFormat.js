// Turns audit entries into readable text. Shared by the Audit log page and an issue's History tab.

// What the audit log can be filtered by: the part of each action before the dot.
export const AUDIT_KINDS = [
  "issue", "comment", "attachment", "project", "board", "sprint", "workflow", "status", "transition",
  "member", "workspace", "billing", "webhook",
];

// Keys whose value is a plain list (not an [old, new] pair), e.g. the issues unassigned when a member left.
const LIST_KEYS = new Set(["unassigned_issues"]);

const show = (v) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One readable line per changed field: {label: "story points", text: "3 → 5"}. */
export function formatChanges(changes) {
  return Object.entries(changes || {}).map(([key, value]) => {
    const label = key.replaceAll("_", " ");
    if (Array.isArray(value) && !LIST_KEYS.has(key) && value.length === 2) {
      return { label, text: `${show(value[0])} → ${show(value[1])}` };
    }
    if (Array.isArray(value)) return { label, text: value.length ? value.map(show).join(", ") : "none" };
    return { label, text: show(value) };
  });
}

/** "issue.role_changed" → "issue role changed". */
export const describeAction = (action) => action.replace(".", " ").replaceAll("_", " ");

/** Colour family for an action's badge. */
export function actionTone(action) {
  const [kind, verb = ""] = action.split(".");
  if (kind === "billing") return "billing";
  if (/^(created|added|subscribe)$/.test(verb)) return "add";
  if (/^(deleted|removed|left|cancel)$/.test(verb)) return "remove";
  if (verb === "deletion_requested") return "warn";
  return "change";
}
