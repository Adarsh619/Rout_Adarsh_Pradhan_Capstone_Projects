import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.VITEST ? "silent" : "info"),
  redact: ["req.headers.authorization", "password", "refresh", "access"],
});
