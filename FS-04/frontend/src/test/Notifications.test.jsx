import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Notifications, { POLL_MS } from "../components/Notifications";

const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
let visibility = "visible";

beforeEach(() => {
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const renderBell = () => render(
  <MemoryRouter initialEntries={["/w/acme"]}>
    <Routes><Route path="/w/:slug" element={<Notifications />} /></Routes>
  </MemoryRouter>
);
const countCalls = (fetch) => fetch.mock.calls.filter(([url]) => url.includes("unread_count")).length;

it("pauses polling while the tab is hidden and catches up when it's shown", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => json({ count: 2 }));
  vi.stubGlobal("fetch", fetch);
  renderBell();
  await act(async () => {});
  expect(countCalls(fetch)).toBe(1);

  visibility = "hidden";
  await act(async () => { vi.advanceTimersByTime(POLL_MS * 3); });
  expect(countCalls(fetch)).toBe(1);

  visibility = "visible";
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(countCalls(fetch)).toBe(2);
  expect(screen.getByRole("button", { name: "Notifications, 2 unread" })).toBeInTheDocument();
});

it("closes the panel on Escape", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url) => json(url.includes("unread_count") ? { count: 0 } : [])));
  renderBell();
  fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
  expect(await screen.findByText("Nothing yet.")).toBeInTheDocument();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByText("Nothing yet.")).not.toBeInTheDocument();
});
