import { canTransition, moveCard } from "../boardLogic";

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
