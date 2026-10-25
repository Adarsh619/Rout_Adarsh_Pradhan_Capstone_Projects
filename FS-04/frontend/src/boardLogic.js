// Pure helpers for the Kanban board (unit-tested in src/test/boardLogic.test.js).

/** Can an issue move from status `from` to `to` given the workflow's transitions? Empty list = free movement. */
export function canTransition(transitions, from, to) {
  if (from === to) return true;
  if (!transitions || transitions.length === 0) return true;
  return transitions.some((t) => t.from_status === from && t.to_status === to);
}

/** Return new columns with the issue moved (optimistic update). Columns: [{status, issues}] */
export function moveCard(columns, source, destination) {
  const next = columns.map((c) => ({ ...c, issues: [...c.issues] }));
  const from = next.find((c) => String(c.status.id) === source.droppableId);
  const to = next.find((c) => String(c.status.id) === destination.droppableId);
  const [card] = from.issues.splice(source.index, 1);
  to.issues.splice(destination.index, 0, { ...card, status: to.status.id, status_name: to.status.name });
  return next;
}
