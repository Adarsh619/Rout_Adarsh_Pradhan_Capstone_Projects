import { fireEvent, render, screen } from "@testing-library/react";
import IssueCard from "../components/IssueCard";

const issue = {
  id: 1, key: "WEB-7", title: "Fix login redirect", type: "bug", priority: "high", story_points: 3,
  comment_count: 2, assignee_detail: { display_name: "Asha Rao" },
};

it("renders issue details and handles clicks", () => {
  const onClick = vi.fn();
  render(<IssueCard issue={issue} onClick={onClick} />);
  expect(screen.getByText("Fix login redirect")).toBeInTheDocument();
  expect(screen.getByText("WEB-7")).toBeInTheDocument();
  expect(screen.getByText("AS")).toBeInTheDocument();
  fireEvent.click(screen.getByText("Fix login redirect"));
  expect(onClick).toHaveBeenCalled();
});

it("marks an overdue card, but not in a done column", () => {
  const late = { ...issue, due_date: "2020-01-05" };
  const { container, rerender } = render(<IssueCard issue={late} />);
  expect(container.querySelector(".card")).toHaveClass("overdue");
  expect(screen.getByTitle("Overdue")).toBeInTheDocument();
  rerender(<IssueCard issue={late} done />);
  expect(container.querySelector(".card")).not.toHaveClass("overdue");
  expect(screen.getByTitle("Due date")).toBeInTheDocument();
});
