import { z } from "zod";
import { AppError } from "../../middleware/errors.js";

// Reports work in Indian time: a "day" runs from midnight to midnight IST, whatever the server's own time zone.
export const TIME_ZONE = "Asia/Kolkata";
const IST_OFFSET = "+05:30";
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_RANGE_DAYS = 366;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const rangeQuery = z.object({ from: ymd.optional(), to: ymd.optional() });

// Today's date in India, as YYYY-MM-DD.
export const todayIst = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export interface DateRange {
  from: string;
  to: string;
  // [start, end) as instants, for MongoDB queries.
  start: Date;
  end: Date;
  days: string[];
}

// from/to are inclusive days. Default: the last 30 days up to today.
export function resolveRange(q: { from?: string; to?: string }, now = new Date()): DateRange {
  const to = q.to ?? todayIst(now);
  const from = q.from ?? addDays(to, -29);
  const start = new Date(`${from}T00:00:00${IST_OFFSET}`);
  const end = new Date(`${addDays(to, 1)}T00:00:00${IST_OFFSET}`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) throw new AppError(400, "validation_error", "Invalid dates");
  if (end <= start) {
    throw new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field: "to", message: "Must be on or after the start date" }] });
  }
  const count = Math.round((end.getTime() - start.getTime()) / DAY_MS);
  if (count > MAX_RANGE_DAYS) {
    throw new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field: "from", message: `At most ${MAX_RANGE_DAYS} days` }] });
  }
  return { from, to, start, end, days: Array.from({ length: count }, (_, i) => addDays(from, i)) };
}

// MongoDB groups instants into Indian days with this.
export const istDay = (field: string) => ({ $dateToString: { format: "%Y-%m-%d", date: `$${field}`, timezone: TIME_ZONE } });

// Every day of the range, zero where nothing happened, so a chart has no gaps.
export function fillDays<T extends Record<string, number>>(days: string[], rows: ({ _id: string } & T)[], zero: T): ({ day: string } & T)[] {
  const byDay = new Map(rows.map((r) => [r._id, r]));
  return days.map((day) => {
    const row = byDay.get(day);
    const values = { ...zero };
    if (row) for (const k of Object.keys(zero) as (keyof T)[]) values[k] = row[k];
    return { day, ...values };
  });
}
