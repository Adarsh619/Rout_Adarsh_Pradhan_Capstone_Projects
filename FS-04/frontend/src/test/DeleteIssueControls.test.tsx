import { fireEvent, render, screen } from "@testing-library/react";
import DeleteIssueControls from "../components/DeleteIssueControls";

const props = { issueKey: "WEB-12", onDelete: vi.fn(), onRequest: vi.fn() };

it("shows Delete to someone who may delete the issue", () => {
  const onDelete = vi.fn();
  render(<DeleteIssueControls {...props} canDelete reporterName="Asha Rao" onDelete={onDelete} />);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onDelete).toHaveBeenCalled();
  expect(screen.queryByText(/Ask an admin/)).not.toBeInTheDocument();
});

it("explains who can delete and sends a request to the admins", async () => {
  const onRequest = vi.fn().mockResolvedValue({ notified: 2 });
  render(<DeleteIssueControls {...props} canDelete={false} reporterName="Asha Rao" onRequest={onRequest} />);
  expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  expect(screen.getByRole("note")).toHaveTextContent("Only Asha Rao (who created WEB-12) or a workspace admin can delete it.");

  fireEvent.click(screen.getByRole("button", { name: "Ask an admin to delete" }));
  expect(onRequest).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("✓ Request sent to admins")).toBeInTheDocument();
});

it("names only admins when the reporter has left", () => {
  render(<DeleteIssueControls {...props} canDelete={false} reporterName={null} />);
  expect(screen.getByRole("note")).toHaveTextContent("Only a workspace admin can delete WEB-12.");
});

it("lets the member retry if the request fails", async () => {
  const onRequest = vi.fn().mockRejectedValue(new Error("offline"));
  render(<DeleteIssueControls {...props} canDelete={false} reporterName="Asha Rao" onRequest={onRequest} />);
  fireEvent.click(screen.getByRole("button", { name: "Ask an admin to delete" }));
  expect(await screen.findByRole("button", { name: "Couldn't send — try again" })).toBeEnabled();
});
