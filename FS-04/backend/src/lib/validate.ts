import { z } from "zod";
import { HttpError } from "./errors.js";

// Validation messages in the wording the web app and the v1 API used ("This field is required." etc.).
z.config({
  customError: (iss) => {
    const input = (iss as { input?: unknown }).input;
    if (iss.code === "invalid_type") {
      if (input === undefined) return "This field is required.";
      if (input === null) return "This field may not be null.";
      if (iss.expected === "number" || iss.expected === "int") return "A valid integer is required.";
      if (iss.expected === "boolean") return "Must be a valid boolean.";
      if (iss.expected === "array") return `Expected a list of items but got type "${typeof input}".`;
      if (iss.expected === "string") return "Not a valid string.";
      return "Invalid value.";
    }
    if (iss.code === "invalid_value") return `"${String(input)}" is not a valid choice.`;
    if (iss.code === "too_small") {
      if (iss.origin === "string") return iss.minimum === 1 ? "This field may not be blank." : `Ensure this field has at least ${iss.minimum} characters.`;
      if (iss.origin === "number") return `Ensure this value is greater than or equal to ${iss.minimum}.`;
    }
    if (iss.code === "too_big") {
      if (iss.origin === "string") return `Ensure this field has no more than ${iss.maximum} characters.`;
      if (iss.origin === "number") return `Ensure this value is less than or equal to ${iss.maximum}.`;
    }
    if (iss.code === "invalid_format") {
      if (iss.format === "email") return "Enter a valid email address.";
      if (iss.format === "url") return "Enter a valid URL.";
      if (iss.format === "date") return "Date has wrong format. Use one of these formats instead: YYYY-MM-DD.";
    }
    return undefined;
  },
});

// Turn Zod issues into { field: [messages] } (or non_field_errors for issues about the whole body).
export function fieldErrors(error: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "non_field_errors";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

// Parse a request body (or query) with `schema`; a failure is a 400 with field errors.
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const result = schema.safeParse(data ?? {});
  if (!result.success) throw new HttpError(400, fieldErrors(result.error));
  return result.data;
}

// ── Reusable field types ─────────────────────────────────────────────────────────────────────────────────────

// Integer ids sent as numbers or numeric strings (form posts send strings).
export const id = z.coerce.number({ error: "Incorrect type. Expected pk value." }).int().positive();

// Optional, nullable id (e.g. assignee: null to unassign).
export const optionalId = id.nullable().optional();

// YYYY-MM-DD, or null.
export const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date has wrong format. Use one of these formats instead: YYYY-MM-DD.")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), "Date has wrong format. Use one of these formats instead: YYYY-MM-DD.");

// A text field that may be blank (Django's blank=True); trimmed like DRF's CharField.
export const text = (max?: number) => (max ? z.string().trim().max(max) : z.string().trim());
// A required, non-blank text field.
export const required = (max: number) => z.string().trim().min(1).max(max);

// PATCH bodies: every field optional, and nothing defaulted (Zod's .partial() keeps defaults).
export function patchOf<T extends z.ZodRawShape>(shape: T) {
  return z.object(Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, (v as z.ZodType).optional()])) as unknown as {
    [K in keyof T]: z.ZodOptional<T[K]>;
  });
}
