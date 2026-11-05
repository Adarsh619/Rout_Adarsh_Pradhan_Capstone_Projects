import { Router, type CookieOptions, type Request, type RequestHandler, type Response } from "express";
import type { Redis } from "ioredis";
import { z } from "zod";
import { hit, peek, reset } from "../../lib/rate-limit.js";
import { requireAuth } from "../../middleware/auth.js";
import { requireCsrfHeader } from "../../middleware/csrf.js";
import { AppError } from "../../middleware/errors.js";
import { validateBody } from "../../middleware/validate.js";
import { User, toPublicUser, type Role, type UserDoc } from "../users/user.model.js";
import { burnPasswordCheck, hashPassword, passwordSchema, verifyPassword } from "./password.js";
import type { SessionStore } from "./sessions.js";
import { parseRefreshToken, type AccessTokens } from "./tokens.js";

export interface AuthConfig {
  redis: Redis;
  tokens: AccessTokens;
  sessions: SessionStore;
  accessTtlSeconds: number;
  refreshTtlDays: number;
  cookieSecure: boolean;
  cookieSameSite: "lax" | "strict" | "none";
  bcryptCost: number;
  // Runs after every successful sign-in or sign-up (moves a guest's cart into the account).
  afterSignIn?: (req: Request, res: Response, userId: string) => Promise<void>;
}

export const REFRESH_COOKIE = "ss_refresh";
// The refresh cookie is only ever sent to the auth endpoints, never with ordinary API calls.
const COOKIE_PATH = "/api/v1/auth";
const LIMITS = {
  registerPerIp: { limit: 10, window: 60 * 60 },
  loginPerIp: { limit: 30, window: 15 * 60 },
  loginFailuresPerEmail: { limit: 5, window: 15 * 60 },
  passwordChangePerUser: { limit: 5, window: 15 * 60 },
};

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

const registerSchema = z.object({
  name: z.string().trim().min(2, "Enter your name").max(80),
  email: emailSchema,
  password: passwordSchema,
  // Admins are never created through sign-up.
  role: z.enum(["customer", "vendor"]).default("customer"),
});

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Enter your password").max(200),
});

const updateAccountSchema = z.object({ name: z.string().trim().min(2, "Enter your name").max(80) });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Enter your current password").max(200),
  newPassword: passwordSchema,
});

export function authRouter(cfg: AuthConfig): { auth: Router; account: Router } {
  const auth = Router();
  const account = Router();
  const signedIn = requireAuth(cfg.tokens, cfg.sessions);

  const cookieOptions = (): CookieOptions => ({
    httpOnly: true,
    secure: cfg.cookieSecure,
    sameSite: cfg.cookieSameSite,
    path: COOKIE_PATH,
    maxAge: cfg.refreshTtlDays * 24 * 60 * 60 * 1000,
  });
  // clearCookie must use the same attributes (minus maxAge) or the browser keeps the old cookie.
  const clearCookie = (res: Response) => {
    const opts = cookieOptions();
    delete opts.maxAge;
    res.clearCookie(REFRESH_COOKIE, opts);
  };

  // Starts a session and answers with the access token; the refresh token goes into the httpOnly cookie.
  const signIn = async (req: Request, res: Response, user: UserDoc, status: number) => {
    const { sid, token } = await cfg.sessions.create(user.id as string, user.role as Role);
    const accessToken = await cfg.tokens.sign({ sub: user.id as string, role: user.role as Role, sid });
    res.cookie(REFRESH_COOKIE, token, cookieOptions());
    await cfg.afterSignIn?.(req, res, user.id as string);
    res.status(status).json({ user: toPublicUser(user), accessToken, expiresIn: cfg.accessTtlSeconds });
  };

  const limitBy =
    (name: keyof typeof LIMITS, keyOf: (req: Request) => string): RequestHandler =>
    async (req, res, next) => {
      try {
        const { limit, window } = LIMITS[name];
        const r = await hit(cfg.redis, `${name}:${keyOf(req)}`, limit, window);
        if (!r.allowed) {
          res.set("Retry-After", String(r.retryAfterSeconds));
          throw new AppError(429, "rate_limited", "Too many attempts. Please wait and try again.", {
            retryAfterSeconds: r.retryAfterSeconds,
          });
        }
        next();
      } catch (err) {
        next(err);
      }
    };

  auth.post(
    "/register",
    limitBy("registerPerIp", (req) => req.ip ?? "unknown"),
    validateBody(registerSchema),
    async (req, res, next) => {
      try {
        const body = req.body as z.infer<typeof registerSchema>;
        const user = await User.create({
          name: body.name,
          email: body.email,
          passwordHash: await hashPassword(body.password, cfg.bcryptCost),
          role: body.role,
          lastLoginAt: new Date(),
        }).catch((err: unknown) => {
          if (typeof err === "object" && err !== null && "code" in err && err.code === 11000) {
            throw new AppError(409, "email_taken", "An account with this email already exists", {
              fields: [{ field: "email", message: "An account with this email already exists" }],
            });
          }
          throw err;
        });
        await signIn(req, res, user, 201);
      } catch (err) {
        next(err);
      }
    },
  );

  auth.post(
    "/login",
    limitBy("loginPerIp", (req) => req.ip ?? "unknown"),
    validateBody(loginSchema),
    async (req, res, next) => {
      try {
        const { email, password } = req.body as z.infer<typeof loginSchema>;
        const failKey = `loginFailuresPerEmail:${email}`;
        const { limit, window } = LIMITS.loginFailuresPerEmail;

        // Too many wrong passwords for this email: stop before checking, so guessing can't continue.
        const before = await peek(cfg.redis, failKey, limit);
        if (!before.allowed) {
          res.set("Retry-After", String(before.retryAfterSeconds));
          throw new AppError(429, "rate_limited", "Too many failed sign-ins for this account. Please wait and try again.", {
            retryAfterSeconds: before.retryAfterSeconds,
          });
        }

        const user = await User.findOne({ email }).select("+passwordHash");
        let ok = false;
        if (user) ok = await verifyPassword(password, user.passwordHash);
        else await burnPasswordCheck(password, cfg.bcryptCost);
        if (!user || !ok) {
          await hit(cfg.redis, failKey, limit, window);
          // Same message for unknown email and wrong password, so it can't be used to find accounts.
          throw new AppError(401, "invalid_credentials", "Email or password is incorrect");
        }
        if (user.status !== "active") {
          throw new AppError(403, "account_suspended", "This account has been suspended. Contact support.");
        }

        await reset(cfg.redis, failKey);
        user.lastLoginAt = new Date();
        await user.save();
        await signIn(req, res, user, 200);
      } catch (err) {
        next(err);
      }
    },
  );

  auth.post("/refresh", requireCsrfHeader, async (req, res, next) => {
    try {
      const parsed = parseRefreshToken(req.cookies?.[REFRESH_COOKIE] as string | undefined);
      if (!parsed) {
        clearCookie(res);
        throw new AppError(401, "session_ended", "Please sign in");
      }

      const result = await cfg.sessions.rotate(parsed.sid, parsed.secret);
      if (result.status === "race") {
        // Another tab refreshed a moment ago; the browser already has the new cookie, so just retry.
        throw new AppError(409, "refresh_in_progress", "Session is being refreshed, please retry");
      }
      if (result.status === "reused") {
        // An old refresh token came back: someone else may hold a copy. Sign this user out everywhere.
        await cfg.sessions.revokeAllForUser(result.uid);
        clearCookie(res);
        throw new AppError(401, "session_reused", "For your security you've been signed out. Please sign in again.");
      }
      if (result.status !== "ok") {
        clearCookie(res);
        throw new AppError(401, "session_ended", "Please sign in");
      }

      const user = await User.findById(result.uid);
      if (!user || user.status !== "active") {
        await cfg.sessions.revoke(parsed.sid);
        clearCookie(res);
        throw new AppError(401, "session_ended", "Please sign in");
      }

      const accessToken = await cfg.tokens.sign({ sub: user.id as string, role: user.role as Role, sid: parsed.sid });
      res.cookie(REFRESH_COOKIE, result.token, cookieOptions());
      res.json({ user: toPublicUser(user), accessToken, expiresIn: cfg.accessTtlSeconds });
    } catch (err) {
      next(err);
    }
  });

  auth.post("/logout", requireCsrfHeader, async (req, res, next) => {
    try {
      const parsed = parseRefreshToken(req.cookies?.[REFRESH_COOKIE] as string | undefined);
      if (parsed) await cfg.sessions.revoke(parsed.sid);
      clearCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  auth.get("/me", signedIn, async (req, res, next) => {
    try {
      const user = await User.findById(req.auth!.id);
      if (!user || user.status !== "active") {
        await cfg.sessions.revoke(req.auth!.sid);
        throw new AppError(401, "session_ended", "Please sign in");
      }
      res.json({ user: toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  account.patch("/", signedIn, validateBody(updateAccountSchema), async (req, res, next) => {
    try {
      const user = await User.findByIdAndUpdate(
        req.auth!.id,
        { name: (req.body as z.infer<typeof updateAccountSchema>).name },
        { returnDocument: "after", runValidators: true },
      );
      if (!user) throw new AppError(404, "not_found", "Account not found");
      res.json({ user: toPublicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  account.post(
    "/password",
    signedIn,
    limitBy("passwordChangePerUser", (req) => req.auth!.id),
    validateBody(changePasswordSchema),
    async (req, res, next) => {
      try {
        const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
        const user = await User.findById(req.auth!.id).select("+passwordHash");
        if (!user) throw new AppError(404, "not_found", "Account not found");
        if (!(await verifyPassword(currentPassword, user.passwordHash))) {
          throw new AppError(400, "validation_error", "Some fields need fixing", {
            fields: [{ field: "currentPassword", message: "Current password is incorrect" }],
          });
        }
        if (currentPassword === newPassword) {
          throw new AppError(400, "validation_error", "Some fields need fixing", {
            fields: [{ field: "newPassword", message: "Choose a password you haven't used here" }],
          });
        }
        user.passwordHash = await hashPassword(newPassword, cfg.bcryptCost);
        user.passwordChangedAt = new Date();
        await user.save();
        // Every other browser signed in to this account is signed out; this one stays signed in.
        const signedOutSessions = await cfg.sessions.revokeAllForUser(user.id as string, req.auth!.sid);
        res.json({ ok: true, signedOutSessions });
      } catch (err) {
        next(err);
      }
    },
  );

  return { auth, account };
}
