import { pino } from "pino";

const level = process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info");

// JSON logs in production (easy to search), readable coloured logs while developing.
export const logger = pino({
  level,
  redact: ["req.headers.authorization", "req.headers.cookie", "*.password", "*.passwordHash"],
  ...(process.env.NODE_ENV === "development" && {
    transport: { target: "pino-pretty", options: { translateTime: "SYS:HH:MM:ss" } },
  }),
});
