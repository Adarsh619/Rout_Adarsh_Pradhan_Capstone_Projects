import type { NextFunction, Request, Response } from "express";
import { prisma } from "../../lib/db.js";
import { unauthorized } from "../../lib/errors.js";
import { verify } from "./tokens.js";

// Read "Authorization: Bearer <access token>" and attach the user. Without a token, req.user stays unset.
export async function readUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get("authorization");
  if (!header) return next();
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    throw unauthorized("Given token not valid for any token type", "token_not_valid");
  }
  const { userId } = await verify(token, "access");
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw unauthorized("User not found", "user_not_found");
  req.user = user;
  next();
}

// Every route except sign-up, login, token refresh, health and the Stripe webhook needs a signed-in user.
export function requireUser(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw unauthorized();
  next();
}

// The signed-in user (for handlers behind requireUser).
export function currentUser(req: Request) {
  if (!req.user) throw unauthorized();
  return req.user;
}
