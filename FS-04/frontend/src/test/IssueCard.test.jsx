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
