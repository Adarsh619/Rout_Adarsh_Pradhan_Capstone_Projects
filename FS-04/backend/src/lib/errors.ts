// API errors keep the v1 (Django REST Framework) response shapes the web app understands:
//   { "detail": "message" }                       request-level errors
//   { "field": ["message", ...], ... }            validation errors per field
//   { "non_field_errors": ["message"] }           validation errors about the whole request

export type ErrorBody = Record<string, unknown>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ErrorBody,
  ) {
    super(typeof body.detail === "string" ? body.detail : `HTTP ${status}`);
  }
}

export type FieldErrors = Record<string, string | string[]>;

const asLists = (fields: FieldErrors): ErrorBody =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, Array.isArray(v) ? v : [v]]));

// 400. A string is a request-level message; an object maps fields to messages.
export const badRequest = (error: string | FieldErrors) =>
  new HttpError(400, typeof error === "string" ? { detail: error } : asLists(error));

export const invalid = (message: string) => new HttpError(400, { non_field_errors: [message] });

export const unauthorized = (detail = "Authentication credentials were not provided.", code?: string) =>
  new HttpError(401, code ? { detail, code } : { detail });

export const paymentRequired = (detail: string) => new HttpError(402, { detail });

export const forbidden = (detail = "You do not have permission to perform this action.") =>
  new HttpError(403, { detail });

export const notFound = (detail = "Not found.") => new HttpError(404, { detail });

export const serviceUnavailable = (detail: string) => new HttpError(503, { detail });
