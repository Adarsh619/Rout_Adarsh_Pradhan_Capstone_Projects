import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Board from "../pages/Board";
import { WorkspaceContext } from "../workspace";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const BOARD = {
  active_sprint: null, transitions: [],
  columns: [
    { status: { id: 1, name: "To Do", category: "todo", color: "#888888" }, issues: [
      { id: 7, key: "WEB-7", title: "Fix login", type: "bug", priority: "high", due_date: null, comment_count: 0 },
    ] },
    { status: { id: 2, name: "Done", category: "done", color: "#22c55e" }, issues: [] },
  ],
};
const ctx = {
  role: "member", user: { id: 1 }, reloadProjects: () => {},
  projects: [{ id: 5, key: "WEB", name: "Website", board_id: 9 }],
  members: [{ user: { id: 2, display_name: "Asha" } }],
};

function Location() {
  const { search } = useLocation();
  return <output data-testid="search">{search}</output>;
}

function renderBoard(path) {
  const fetch = vi.fn(async (url) => json(url.includes("/boards/") ? BOARD : { results: [] }));
  vi.stubGlobal("fetch", fetch);
  render(
    <WorkspaceContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/w/:slug/p/:projectId/board" element={<><Board /><Location /></>} /></Routes>
      </MemoryRouter>
    </WorkspaceContext.Provider>
  );
  return fetch;
}
const boardCalls = (fetch) => fetch.mock.calls.map(([url]) => url).filter((u) => u.includes("/boards/"));

afterEach(() => { vi.unstubAllGlobals(); });

it("reads its filters from the URL, so a reload or shared link shows the same board", async () => {
  const fetch = renderBoard("/w/acme/p/5/board?assignee=2&sprint=active");
  expect(await screen.findByText("Fix login")).toBeInTheDocument();
  expect(boardCalls(fetch)[0]).toContain("sprint=active");
  expect(boardCalls(fetch)[0]).toContain("assignee=2");
  expect(screen.getByLabelText("Assignee")).toHaveValue("2");
  expect(screen.getByText("No matching issues")).toBeInTheDocument();
});

it("searches once typing pauses, not on every key", async () => {
  const fetch = renderBoard("/w/acme/p/5/board");
  await screen.findByText("Fix login");
  const box = screen.getByLabelText("Search issues");
  for (const text of ["l", "lo", "log", "login"]) fireEvent.change(box, { target: { value: text } });
  await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?q=login"));
  await waitFor(() => expect(boardCalls(fetch).at(-1)).toContain("q=login"));
  expect(boardCalls(fetch)).toHaveLength(2); // the first load plus one search
});

it("opens an issue from the keyboard and puts it in the URL", async () => {
  renderBoard("/w/acme/p/5/board");
  fireEvent.keyDown(await screen.findByLabelText("WEB-7 Fix login"), { key: "Enter" });
  await waitFor(() => expect(screen.getByTestId("search")).toHaveTextContent("?issue=7"));
  expect(await screen.findByRole("dialog")).toBeInTheDocument();
});
