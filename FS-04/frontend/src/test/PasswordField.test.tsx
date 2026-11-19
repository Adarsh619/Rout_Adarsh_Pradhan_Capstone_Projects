import { fireEvent, render, screen } from "@testing-library/react";
import PasswordField from "../components/PasswordField";

it("shows and hides the password without submitting the form", () => {
  const onSubmit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  render(<form onSubmit={onSubmit}><PasswordField label="Password" defaultValue="demo12345" /></form>);
  const input = screen.getByLabelText("Password");
  const toggle = screen.getByRole("button", { name: "Show password" });
  expect(input).toHaveAttribute("type", "password");
  expect(toggle).toHaveAttribute("aria-pressed", "false");

  fireEvent.click(toggle);
  expect(input).toHaveAttribute("type", "text");
  expect(input).toHaveValue("demo12345");
  expect(toggle).toHaveAttribute("aria-pressed", "true");

  fireEvent.click(toggle);
  expect(input).toHaveAttribute("type", "password");
  expect(onSubmit).not.toHaveBeenCalled();
});
