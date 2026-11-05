import type { RequestHandler } from "express";
import type { AccessTokens } from "../modules/auth/tokens.js";
import type { SessionStore } from "../modules/auth/sessions.js";
import type { Role } from "../modules/users/user.model.js";
import { AppError } from "./errors.js";

export interface AuthUser {
  id: string;
  role: Role;
  sid: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthUser;
  }
}

async function authenticate(tokens: AccessTokens, sessions: SessionStore, token: string): Promise<AuthUser> {
  const claims = await tokens.verify(token);
  if (claims === "expired") throw new AppError(401, "token_expired", "Your session token has expired");
  if (claims === "invalid") throw new AppError(401, "unauthenticated", "Please sign in");
  if (!(await sessions.isActive(claims.sid))) throw new AppError(401, "session_ended", "You have been signed out");
  return { id: claims.sub, role: claims.role, sid: claims.sid };
}

const bearerToken = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined);

// Checks the Bearer token and that its session still exists in Redis (so logout, password changes and
// suspensions apply immediately, not when the 15-minute token expires).
export function requireAuth(tokens: AccessTokens, sessions: SessionStore): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req.get("authorization"));
      if (!token) throw new AppError(401, "unauthenticated", "Please sign in");
      req.auth = await authenticate(tokens, sessions, token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// For endpoints guests can use too (the cart): no token means a guest, but a token that is sent must be valid,
// so an expired one still answers token_expired and the app refreshes it instead of silently using a guest cart.
export function optionalAuth(tokens: AccessTokens, sessions: SessionStore): RequestHandler {
  return async (req, _res, next) => {
    try {
      const token = bearerToken(req.get("authorization"));
      if (token) req.auth = await authenticate(tokens, sessions, token);
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Use after requireAuth. Lists the allowed roles in the error so the frontend can explain why.
export const requireRole =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth) return next(new AppError(401, "unauthenticated", "Please sign in"));
    if (!roles.includes(req.auth.role)) {
      return next(new AppError(403, "forbidden", "Your account can't do this", { requiredRoles: roles }));
    }
    next();
  };
