import type { RequestHandler } from "express";
import { AppError } from "./errors.js";

// Endpoints that act on a cookie (sign-in refresh, logout, the guest cart) require this header. Browsers only let
// another site send a custom header after a CORS preflight, which our CORS policy refuses, so a malicious page
// can't trigger them (CSRF). The app's API client always sends it.
export const CSRF_HEADER = "x-requested-with";
export const CSRF_VALUE = "ShopSphere";

export const requireCsrfHeader: RequestHandler = (req, _res, next) => {
  if (req.get(CSRF_HEADER) !== CSRF_VALUE) {
    return next(new AppError(403, "csrf_header_missing", "Missing X-Requested-With header"));
  }
  next();
};
