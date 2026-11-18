import { actionTone, describeAction, formatChanges } from "../auditFormat";

describe("formatChanges", () => {
  it("shows [old, new] pairs as an arrow, with — for empty values", () => {
    expect(formatChanges({ status: ["To Do", "In Progress"], assignee: [null, 7] })).toEqual([
      { label: "status", text: "To Do → In Progress" },
      { label: "assignee", text: "— → 7" },
    ]);
  });

  it("humanises keys and keeps lists as lists, even with two items", () => {
    expect(formatChanges({ unassigned_issues: ["WEB-1", "WEB-2"], returned_to_backlog: 3 })).toEqual([
      { label: "unassigned issues", text: "WEB-1, WEB-2" },
      { label: "returned to backlog", text: "3" },
    ]);
    expect(formatChanges({ unassigned_issues: [] })[0].text).toBe("none");
  });

  it("handles entries without changes", () => {
    expect(formatChanges({})).toEqual([]);
    expect(formatChanges(null)).toEqual([]);
  });
});

it("describes actions and picks a badge colour", () => {
  expect(describeAction("member.role_changed")).toBe("member role changed");
  expect(actionTone("issue.created")).toBe("add");
  expect(actionTone("member.left")).toBe("remove");
  expect(actionTone("issue.moved")).toBe("change");
  expect(actionTone("issue.deletion_requested")).toBe("warn");
  expect(actionTone("billing.cancel")).toBe("billing");
});
