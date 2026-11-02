import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "./client";

export interface Health {
  status: "ok" | "degraded";
  services: Record<string, "up" | "down">;
  version: string;
  time: string;
}

// A 503 still carries the per-service report, so show it instead of treating it as a plain error.
async function fetchHealth(): Promise<Health> {
  try {
    return await api<Health>("/health");
  } catch (err) {
    if (err instanceof ApiError && err.status === 503 && err.body) return err.body as Health;
    throw err;
  }
}

export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: fetchHealth, refetchInterval: 30_000, retry: false });
