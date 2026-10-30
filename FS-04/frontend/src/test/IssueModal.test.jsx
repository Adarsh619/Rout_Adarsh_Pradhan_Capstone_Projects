import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import IssueModal, { MAX_UPLOAD_BYTES } from "../components/IssueModal";
import { WorkspaceContext } from "../workspace";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const STATUSES = [{ id: 1, name: "To Do" }, { id: 2, name: "In Progress" }, { id: 3, name: "Done" }];
const ISSUE = {
  id: 7, key: "WEB-7", title: "Fix login", description: "", type: "bug", priority: "high", status: 1,
  assignee: null, story_points: null, due_date: null, sprint: null, can_delete: true, reporter_detail: null,
};
const ctx = { members: [], role: "member", user: { id: 1 } };

function renderModal(props) {
  return render(
    <WorkspaceContext.Provider value={ctx}>
      <IssueModal projectId="5" statuses={STATUSES} onClose={() => {}} {...props} />
    </WorkspaceContext.Provider>
  );
}

function stubIssueApi(overrides = {}) {
  const fetch = vi.fn(async (url, opts = {}) => {
    for (const [pattern, handler] of Object.entries(overrides)) if (url.includes(pattern)) return handler(url, opts);
    if (url.includes("/history/")) return json(200, []);
    if (url.includes("/comments/") || url.includes("/attachments/")) return json(200, { results: [] });
    return json(200, ISSUE);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("creates the issue once even if Create is clicked twice", async () => {
  let finish;
  const fetch = stubIssueApi({ "/api/issues/": () => new Promise((r) => { finish = () => r(json(201, ISSUE)); }) });
  const onClose = vi.fn();
  renderModal({ defaultStatus: 1, onClose });
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "New bug" } });
  const create = screen.getByRole("button", { name: "Create issue" });
  fireEvent.click(create);
  fireEvent.click(create);
  expect(await screen.findByRole("button", { name: "Saving…" })).toBeDisabled();
  await act(async () => finish());
  expect(fetch.mock.calls.filter(([, o]) => o.method === "POST")).toHaveLength(1);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it("offers only the statuses the workflow allows", async () => {
  stubIssueApi();
  renderModal({ issueId: 7, transitions: [{ from_status: 1, to_status: 2 }] });
  const status = await screen.findByLabelText("Status");
  expect([...status.options].map((o) => o.textContent)).toEqual(["To Do", "In Progress"]);
});

it("refuses files over 10 MB before uploading", async () => {
  const fetch = stubIssueApi();
  renderModal({ issueId: 7 });
  fireEvent.click(await screen.findByRole("button", { name: /attachments/ }));
  const big = new File(["x"], "video.mp4");
  Object.defineProperty(big, "size", { value: MAX_UPLOAD_BYTES + 1 });
  fireEvent.change(screen.getByLabelText(/Attach a file/), { target: { files: [big] } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Attachments can be up to 10 MB");
  expect(fetch.mock.calls.some(([, o]) => o.method === "POST")).toBe(false);
});

it("explains when the issue no longer exists", async () => {
  stubIssueApi({ "/api/issues/7/": (url) => (url.endsWith("/api/issues/7/") ? json(404, { detail: "Not found." }) : json(200, [])) });
  renderModal({ issueId: 7 });
  expect(await screen.findByRole("alert")).toHaveTextContent("doesn't exist any more");
});

it("asks before discarding unsaved edits", async () => {
  stubIssueApi();
  const onClose = vi.fn();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  renderModal({ issueId: 7, onClose });
  fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Changed" } });
  expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(confirm).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalled();
});
