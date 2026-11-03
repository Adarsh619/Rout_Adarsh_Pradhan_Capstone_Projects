import type { RequestHandler } from "express";
import type { z } from "zod";
import { AppError } from "./errors.js";

// Parses req.body with a Zod schema and replaces it with the clean result, or answers 400 with every problem.
export const validateBody =
  <T extends z.ZodType>(schema: T): RequestHandler =>
  (req, _res, next) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // One message per field (the first rule it broke), which is what a form shows next to the input.
      const fields: { field: string; message: string }[] = [];
      for (const issue of parsed.error.issues) {
        const field = issue.path.join(".");
        if (!fields.some((f) => f.field === field)) fields.push({ field, message: issue.message });
      }
      next(new AppError(400, "validation_error", "Some fields need fixing", { fields }));
      return;
    }
    req.body = parsed.data;
    next();
  };
