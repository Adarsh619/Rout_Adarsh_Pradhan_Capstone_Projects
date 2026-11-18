import type { DraggableLocation } from "@hello-pangea/dnd";
import type { Column, Issue, Transition } from "./types";

// Pure helpers for the Kanban board (unit-tested in src/test/boardLogic.test.js).

/** Can an issue move from status `from` to `to` given the workflow's transitions? Empty list = free movement. */
export function canTransition(transitions: Transition[] | null | undefined, from: number, to: number): boolean {
  if (from === to) return true;
  if (!transitions || transitions.length === 0) return true;
  return transitions.some((t) => t.from_status === from && t.to_status === to);
}

/** Return new columns with the issue moved (optimistic update). Columns: [{status, issues}] */
export function moveCard(columns: Column[], source: DraggableLocation, destination: DraggableLocation): Column[] {
  const next = columns.map((c) => ({ ...c, issues: [...c.issues] }));
  const from = next.find((c) => String(c.status.id) === source.droppableId);
  const to = next.find((c) => String(c.status.id) === destination.droppableId);
  if (!from || !to) return columns;
  const [card] = from.issues.splice(source.index, 1);
  if (!card) return columns;
  to.issues.splice(destination.index, 0, { ...card, status: to.status.id, status_name: to.status.name });
  return next;
}

/**
 * Where a dropped card goes, as the server understands it. A filtered board hides some cards, so the
 * drop index only counts visible ones; naming the visible neighbour keeps the card next to it.
 * `columns` are the columns *after* the optimistic move.
 */
export function dropPosition(columns: Column[], destination: DraggableLocation): { index: number; after?: number; before?: number } {
  const column = columns.find((c) => String(c.status.id) === destination.droppableId);
  const index = destination.index;
  const previous = column?.issues[index - 1];
  const next = column?.issues[index + 1];
  if (previous) return { index, after: previous.id };
  if (next) return { index, before: next.id };
  return { index };
}

/** Is the issue past its due date and not in a "done" column? Dates are compared as local calendar days. */
export function isOverdue(issue: Pick<Issue, "due_date">, columnIsDone = false, today = new Date()): boolean {
  if (!issue.due_date || columnIsDone) return false;
  const pad = (n: number) => String(n).padStart(2, "0");
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  return issue.due_date < todayStr;
}
