import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// findBy* / waitFor wait up to 5 s (default 1 s): pages render more slowly under coverage and on CI runners.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no layout, so scrolling does nothing (and would log "not implemented").
window.scrollTo = () => {};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
