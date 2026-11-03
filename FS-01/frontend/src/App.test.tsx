import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { errorResponse, jsonResponse, mockApi, renderWithProviders } from "./test/render";

const health = (status: "ok" | "degraded", services: Record<string, "up" | "down">) => ({
  status,
  services,
  version: "dev",
  time: new Date().toISOString(),
});

describe("home page", () => {
  it("shows the marketplace pitch and every service as up", async () => {
    mockApi({
      "GET /api/v1/health": () => jsonResponse(health("ok", { mongo: "up", redis: "up", elasticsearch: "up", s3: "up" })),
    });
    renderWithProviders(<App />);

    expect(screen.getByRole("heading", { name: /many sellers\. one cart\. one checkout\./i })).toBeInTheDocument();
    expect(await screen.findByText("All systems up")).toBeInTheDocument();
    expect(screen.getByText("Search (Elasticsearch)")).toBeInTheDocument();
    expect(screen.getAllByText("Up")).toHaveLength(4);
  });

  it("shows which service is down when the API reports 503", async () => {
    mockApi({
      "GET /api/v1/health": () => jsonResponse(health("degraded", { mongo: "up", elasticsearch: "down" }), 503),
    });
    renderWithProviders(<App />);

    expect(await screen.findByText("Some services down")).toBeInTheDocument();
    expect(screen.getByText("Down")).toBeInTheDocument();
  });

  it("says so when the API cannot be reached", async () => {
    mockApi({
      "GET /api/v1/health": () => {
        throw new TypeError("Failed to fetch");
      },
    });
    renderWithProviders(<App />);

    expect(await screen.findByText(/the api is not reachable/i)).toBeInTheDocument();
  });

  it("offers sign-in and sign-up to visitors", async () => {
    mockApi({ "GET /api/v1/health": () => errorResponse(503, "down") });
    renderWithProviders(<App />);
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute("href", "/register");
  });
});

describe("routing", () => {
  it("shows a friendly page for unknown URLs", () => {
    mockApi({});
    renderWithProviders(<App />, { route: "/does-not-exist" });

    expect(screen.getByRole("heading", { name: /page not found/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the home page/i })).toHaveAttribute("href", "/");
  });
});
