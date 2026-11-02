import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { jsonResponse, renderWithProviders } from "./test/render";

const health = (status: "ok" | "degraded", services: Record<string, "up" | "down">) => ({
  status,
  services,
  version: "dev",
  time: new Date().toISOString(),
});

describe("home page", () => {
  it("shows the marketplace pitch and every service as up", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(health("ok", { mongo: "up", redis: "up", elasticsearch: "up", s3: "up" })),
    );
    renderWithProviders(<App />);

    expect(screen.getByRole("heading", { name: /many sellers\. one cart\. one checkout\./i })).toBeInTheDocument();
    expect(await screen.findByText("All systems up")).toBeInTheDocument();
    expect(screen.getByText("Search (Elasticsearch)")).toBeInTheDocument();
    expect(screen.getAllByText("Up")).toHaveLength(4);
  });

  it("shows which service is down when the API reports 503", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(health("degraded", { mongo: "up", elasticsearch: "down" }), 503),
    );
    renderWithProviders(<App />);

    expect(await screen.findByText("Some services down")).toBeInTheDocument();
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("says so when the API cannot be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    renderWithProviders(<App />);

    expect(await screen.findByText(/the api is not reachable/i)).toBeInTheDocument();
  });
});

describe("routing", () => {
  it("shows a friendly page for unknown URLs", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}));
    renderWithProviders(<App />, { route: "/does-not-exist" });

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the home page/i })).toHaveAttribute("href", "/");
  });
});
