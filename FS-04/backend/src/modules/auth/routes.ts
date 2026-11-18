import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { isUniqueViolation, prisma } from "../../lib/db.js";
import { badRequest, forbidden, unauthorized } from "../../lib/errors.js";
import { parse, patchOf, text } from "../../lib/validate.js";
import { createWorkspace } from "../tenancy/services.js";
import { DEMO_ACCOUNT_MESSAGE, isLockedDemoAccount } from "./demo.js";
import { currentUser, requireUser } from "./middleware.js";
import { burnTime, checkPassword, hashPassword, passwordProblems } from "./passwords.js";
import { meOut } from "./serialize.js";
import { revoke, revokeAll, rotate, tokenPair } from "./tokens.js";

const email = z.email().max(254).transform((e) => e.toLowerCase());

const registerBody = z.object({
  email,
  password: z.string(),
  full_name: text(150).optional(),
  workspace_name: text(100).optional(),
});
const loginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });
const refreshBody = z.object({ refresh: z.string().min(1) });
const meBody = patchOf({ full_name: text(150) });
const passwordBody = z.object({ current_password: z.string().min(1), new_password: z.string().min(1) });

// `authLimit` throttles the endpoints that take a password (AUTH_RATE_LIMIT, per IP or per user).
export function authRouter(authLimit: RequestHandler): Router {
  const r = Router();

  // Create an account (and optionally a first workspace). Returns tokens.
  r.post("/register/", authLimit, async (req, res) => {
    const data = parse(registerBody, req.body);
    if (await prisma.user.findUnique({ where: { email: data.email } })) {
      throw badRequest({ email: "An account with this email already exists." });
    }
    const problems = passwordProblems(data.password, { email: data.email, fullName: data.full_name });
    if (problems.length) throw badRequest({ password: problems });
    let user;
    try {
      user = await prisma.user.create({
        data: { email: data.email, password: await hashPassword(data.password), fullName: data.full_name ?? "" },
      });
    } catch (err) {
      // Two sign-ups with the same email can both pass the check above; the unique index stops the second.
      if (isUniqueViolation(err)) throw badRequest({ email: "An account with this email already exists." });
      throw err;
    }
    const workspace = data.workspace_name ? await createWorkspace(data.workspace_name, user) : null;
    res.status(201).json({ user: meOut(user), ...(await tokenPair(user.id)), workspace: workspace?.slug ?? null });
  });

  // Email + password → access and refresh tokens.
  r.post("/token/", authLimit, async (req, res) => {
    const data = parse(loginBody, req.body);
    const user = await prisma.user.findUnique({ where: { email: data.email.toLowerCase() } });
    const ok = user ? await checkPassword(data.password, user.password) : await burnTime(data.password);
    if (!user || !ok) throw unauthorized("No active account found with the given credentials");
    res.json(await tokenPair(user.id));
  });

  // A refresh token for a new pair (the old refresh token stops working).
  r.post("/token/refresh/", async (req, res) => {
    res.json(await rotate(parse(refreshBody, req.body).refresh));
  });

  // Blacklist the given refresh token.
  r.post("/logout/", async (req, res) => {
    await revoke(parse(refreshBody, req.body).refresh);
    res.json({});
  });

  r.get("/me/", requireUser, (req, res) => {
    res.json(meOut(currentUser(req)));
  });

  const updateMe: RequestHandler = async (req, res) => {
    const user = currentUser(req);
    if (isLockedDemoAccount(user)) throw forbidden(DEMO_ACCOUNT_MESSAGE);
    const data = parse(meBody, req.body);
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: data.full_name === undefined ? {} : { fullName: data.full_name },
    });
    res.json(meOut(updated));
  };
  r.patch("/me/", requireUser, updateMe);
  r.put("/me/", requireUser, updateMe);

  // Change your password. Every refresh token you hold is revoked; a fresh pair is returned for this session.
  r.post("/password/", requireUser, authLimit, async (req, res) => {
    const user = currentUser(req);
    if (isLockedDemoAccount(user)) throw forbidden(DEMO_ACCOUNT_MESSAGE);
    const data = parse(passwordBody, req.body);
    const errors: Record<string, string[]> = {};
    if (!(await checkPassword(data.current_password, user.password))) {
      errors.current_password = ["Current password is incorrect."];
    }
    const problems = passwordProblems(data.new_password, user);
    if (problems.length) errors.new_password = problems;
    if (Object.keys(errors).length) throw badRequest(errors);
    const hash = await hashPassword(data.new_password);
    const tokens = await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { password: hash } });
      await revokeAll(user.id, tx);
      return tokenPair(user.id, tx);
    });
    res.json(tokens);
  });

  return r;
}
