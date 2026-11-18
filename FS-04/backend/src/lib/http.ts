import type { Request } from "express";
import { badRequest, notFound } from "./errors.js";

// ── Pagination: the v1 limit/offset format { count, next, previous, results } (100 per page) ────────────────────
export const PAGE_SIZE = 100;

export interface Page {
  limit: number;
  offset: number;
}

function positive(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function pageOf(req: Request): Page {
  const limit = positive(req.query.limit, PAGE_SIZE);
  return { limit: limit === 0 ? PAGE_SIZE : limit, offset: positive(req.query.offset, 0) };
}

function pageUrl(req: Request, limit: number, offset: number): string {
  const url = new URL(req.originalUrl, `${req.protocol}://${req.get("host") ?? "localhost"}`);
  url.searchParams.set("limit", String(limit));
  if (offset > 0) url.searchParams.set("offset", String(offset));
  else url.searchParams.delete("offset");
  return url.toString();
}

export function paginated<T>(req: Request, page: Page, count: number, results: T[]) {
  const { limit, offset } = page;
  return {
    count,
    next: offset + limit < count ? pageUrl(req, limit, offset + limit) : null,
    previous: offset > 0 ? pageUrl(req, limit, Math.max(offset - limit, 0)) : null,
    results,
  };
}

// ── Route and query parameters ────────────────────────────────────────────────────────────────────────────────

// A numeric route id; anything else is simply "not found" (as the v1 API answered).
export function routeId(req: Request, name = "id"): number {
  const raw = req.params[name];
  const n = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647) throw notFound();
  return n;
}

export function queryString(req: Request, name: string): string | undefined {
  const v = req.query[name];
  return typeof v === "string" && v !== "" ? v : undefined;
}

// An optional integer filter (?project=5); a non-number is a 400 on that field.
export function queryInt(req: Request, name: string): number | undefined {
  const v = queryString(req, name);
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw badRequest({ [name]: "Select a valid choice. That choice is not one of the available choices." });
  return Number(v);
}

// An optional boolean filter (?read=true).
export function queryBool(req: Request, name: string): boolean | undefined {
  const v = queryString(req, name)?.toLowerCase();
  if (v === undefined) return undefined;
  if (["true", "1"].includes(v)) return true;
  if (["false", "0"].includes(v)) return false;
  throw badRequest({ [name]: "Enter a valid boolean." });
}

// An optional choice filter (?priority=high).
export function queryChoice<T extends string>(req: Request, name: string, choices: readonly T[]): T | undefined {
  const v = queryString(req, name);
  if (v === undefined) return undefined;
  if (!(choices as readonly string[]).includes(v)) {
    throw badRequest({ [name]: "Select a valid choice. That choice is not one of the available choices." });
  }
  return v as T;
}

// "?ordering=-priority,created_at" → [["priority","desc"],["created_at","asc"]], keeping only allowed fields.
export function ordering(req: Request, allowed: readonly string[]): Array<[string, "asc" | "desc"]> {
  const raw = queryString(req, "ordering");
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => allowed.includes(s.replace(/^-/, "")))
    .map((s) => [s.replace(/^-/, ""), s.startsWith("-") ? "desc" : "asc"]);
}

// ── Output helpers ────────────────────────────────────────────────────────────────────────────────────────────

// Dates as the API has always sent them: timestamps in ISO 8601 UTC, calendar dates as YYYY-MM-DD.
export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);
export const toDate = (s: string | null | undefined): Date | null | undefined =>
  s === undefined ? undefined : s === null ? null : new Date(`${s}T00:00:00Z`);
// Today's date in UTC (the server's time zone, as in v1).
export const today = (): Date => new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
