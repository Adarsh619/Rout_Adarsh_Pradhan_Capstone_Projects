import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import Modal from "../components/Modal";

function Harness({ onClose = () => {} }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Modal title="Edit issue" onClose={() => { onClose(); setOpen(false); }}>
          <input aria-label="Title" />
          <button>Save</button>
        </Modal>
      )}
    </>
  );
}

it("is a labelled modal dialog that takes focus and gives it back on close", () => {
  render(<Harness />);
  const opener = screen.getByRole("button", { name: "Open" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Edit issue" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(opener).toHaveFocus();
});

it("keeps Tab inside the dialog", () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  const close = screen.getByRole("button", { name: "Close" });
  const save = screen.getByRole("button", { name: "Save" });
  save.focus();
  fireEvent.keyDown(save, { key: "Tab" });
  expect(close).toHaveFocus();
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(save).toHaveFocus();
});

it("closes when the backdrop is clicked but not the dialog", () => {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  fireEvent.mouseDown(screen.getByRole("dialog"));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.mouseDown(screen.getByRole("dialog").parentElement);
  expect(onClose).toHaveBeenCalledTimes(1);
});
