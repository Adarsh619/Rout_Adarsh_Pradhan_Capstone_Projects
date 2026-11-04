import type { Request, RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "./errors.js";

type FieldError = { field: string; message: string };

// One message per field (the first rule it broke), which is what a form shows next to the input.
function fieldErrors(error: z.ZodError): FieldError[] {
  const fields: FieldError[] = [];
  for (const issue of error.issues) {
    const field = issue.path.join(".");
    if (!fields.some((f) => f.field === field)) fields.push({ field, message: issue.message });
  }
  return fields;
}

// Parses req.body with a Zod schema and replaces it with the clean result, or answers 400 with every problem.
export const validateBody =
  <T extends z.ZodType>(schema: T): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      next(new AppError(400, "validation_error", "Some fields need fixing", { fields: fieldErrors(parsed.error) }));
      return;
    }
    req.body = parsed.data;
    next();
  };

// Express 5 makes req.query read-only, so query strings are parsed inside the handler instead.
export function parseQuery<T extends z.ZodType>(schema: T, req: Request): z.infer<T> {
  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    throw new AppError(400, "validation_error", "Invalid query parameters", { fields: fieldErrors(parsed.error) });
  }
  return parsed.data;
}

// page (from 1) and limit (max 50), shared by every list endpoint.
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// 24 hex characters only (mongoose's isValidObjectId also accepts any 12-character string).
const OBJECT_ID = /^[0-9a-f]{24}$/i;
export const objectId = z.string().regex(OBJECT_ID, "Invalid id");

// For :id route parameters: an id that can't exist is a 404, the same as one that doesn't.
export function idParam(req: Request, name = "id"): string {
  const id = req.params[name];
  if (typeof id !== "string" || !OBJECT_ID.test(id)) throw new AppError(404, "not_found", "Not found");
  return id;
}
