import { canTransition, dropPosition, isOverdue, moveCard } from "../boardLogic";

const cols = [
  { status: { id: 1, name: "To Do" }, issues: [{ id: 10 }, { id: 11 }] },
  { status: { id: 2, name: "Doing" }, issues: [{ id: 20 }] },
];

describe("canTransition", () => {
  it("allows anything when no transitions are defined", () => {
    expect(canTransition([], 1, 3)).toBe(true);
  });
  it("enforces defined transitions", () => {
    const t = [{ from_status: 1, to_status: 2 }];
    expect(canTransition(t, 1, 2)).toBe(true);
    expect(canTransition(t, 2, 1)).toBe(false);
    expect(canTransition(t, 2, 2)).toBe(true);
  });
});

describe("moveCard", () => {
  it("moves a card between columns at the given index without mutating input", () => {
    const next = moveCard(cols, { droppableId: "1", index: 0 }, { droppableId: "2", index: 0 });
    expect(next[0].issues.map((i) => i.id)).toEqual([11]);
    expect(next[1].issues.map((i) => i.id)).toEqual([10, 20]);
    expect(next[1].issues[0].status).toBe(2);
    expect(cols[0].issues).toHaveLength(2);
  });
  it("reorders inside a column", () => {
    const next = moveCard(cols, { droppableId: "1", index: 0 }, { droppableId: "1", index: 1 });
    expect(next[0].issues.map((i) => i.id)).toEqual([11, 10]);
  });
});

describe("dropPosition", () => {
  const after = (cols2, droppableId, index) => dropPosition(cols2, { droppableId, index });
  const board = [
    { status: { id: 1 }, issues: [{ id: 10 }, { id: 99 }, { id: 11 }] },
    { status: { id: 2 }, issues: [{ id: 99 }] },
  ];
  it("names the visible card above the drop", () => {
    expect(after(board, "1", 1)).toEqual({ index: 1, after: 10 });
  });
  it("names the card below when dropped at the top", () => {
    expect(after(board, "1", 0)).toEqual({ index: 0, before: 99 });
  });
  it("falls back to the index in an otherwise empty column", () => {
    expect(after(board, "2", 0)).toEqual({ index: 0 });
  });
});

describe("isOverdue", () => {
  const today = new Date(2026, 9, 30); // 30 Oct 2026
  it("flags past due dates outside done columns", () => {
    expect(isOverdue({ due_date: "2026-10-29" }, false, today)).toBe(true);
    expect(isOverdue({ due_date: "2026-10-30" }, false, today)).toBe(false);
    expect(isOverdue({ due_date: "2026-10-29" }, true, today)).toBe(false);
    expect(isOverdue({ due_date: null }, false, today)).toBe(false);
  });
});
