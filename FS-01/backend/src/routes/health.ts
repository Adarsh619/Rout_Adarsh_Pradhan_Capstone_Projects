import { Router } from "express";
import { runHealthChecks, type HealthCheck } from "../lib/health.js";

// GET /api/v1/health → 200 when every service answers, 503 otherwise.
// Used by Docker health checks, the CI smoke test, UptimeRobot and the status badge on the home page.
export function healthRouter(checks: Record<string, HealthCheck>): Router {
  const router = Router();
  router.get("/", async (_req, res) => {
    const report = await runHealthChecks(checks);
    res
      .status(report.status === "ok" ? 200 : 503)
      .set("Cache-Control", "no-store")
      .json({ ...report, version: process.env.APP_VERSION ?? "dev", time: new Date().toISOString() });
  });
  return router;
}
