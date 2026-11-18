import { randomUUID } from "node:crypto";
import { errors, jwtVerify, SignJWT } from "jose";
import { config } from "../../config.js";
import { prisma, type Tx } from "../../lib/db.js";
import { unauthorized } from "../../lib/errors.js";

// JSON Web Tokens, as in v1: a short-lived access token (60 min) and a refresh token (7 days).
// Every refresh token is recorded; using one rotates it (the old one is revoked), and logout or a password
// change revokes them, so a leaked refresh token stops working.

type TokenType = "access" | "refresh";

const key = () => new TextEncoder().encode(config.secretKey);

async function sign(type: TokenType, userId: number, jti: string, lifetimeSeconds: number): Promise<string> {
  return new SignJWT({ token_type: type, user_id: String(userId) })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + lifetimeSeconds)
    .sign(key());
}

export async function tokenPair(userId: number, tx: Tx = prisma): Promise<{ access: string; refresh: string }> {
  const jti = randomUUID().replaceAll("-", "");
  const refreshSeconds = config.JWT_REFRESH_DAYS * 86_400;
  await tx.refreshToken.create({
    data: { jti, userId, expiresAt: new Date(Date.now() + refreshSeconds * 1000) },
  });
  return {
    refresh: await sign("refresh", userId, jti, refreshSeconds),
    access: await sign("access", userId, randomUUID().replaceAll("-", ""), config.JWT_ACCESS_MINUTES * 60),
  };
}

const INVALID = () => unauthorized("Token is invalid or expired", "token_not_valid");

// Verify a token's signature, expiry and type; returns the user id and token id.
export async function verify(token: string, type: TokenType): Promise<{ userId: number; jti: string }> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    const userId = Number(payload.user_id);
    if (payload.token_type !== type || !Number.isSafeInteger(userId) || !payload.jti) throw INVALID();
    return { userId, jti: payload.jti };
  } catch (err) {
    if (err instanceof errors.JOSEError || err instanceof TypeError) throw INVALID();
    throw err;
  }
}

// Exchange a refresh token for a new pair; the old refresh token is revoked in the same transaction.
export async function rotate(refresh: string): Promise<{ access: string; refresh: string }> {
  const { userId, jti } = await verify(refresh, "refresh");
  return prisma.$transaction(async (tx) => {
    // Conditional update: of two simultaneous refreshes with the same token, only one wins.
    const revoked = await tx.refreshToken.updateMany({
      where: { jti, userId, revokedAt: null, expiresAt: { gt: new Date() } },
      data: { revokedAt: new Date() },
    });
    if (revoked.count !== 1) throw unauthorized("Token is blacklisted", "token_not_valid");
    return tokenPair(userId, tx);
  });
}

// Revoke one refresh token (logout).
export async function revoke(refresh: string): Promise<void> {
  const { jti } = await verify(refresh, "refresh");
  const row = await prisma.refreshToken.findUnique({ where: { jti } });
  if (!row || row.revokedAt) throw unauthorized("Token is blacklisted", "token_not_valid");
  await prisma.refreshToken.update({ where: { jti }, data: { revokedAt: new Date() } });
}

// Revoke every refresh token a user holds (password change).
export async function revokeAll(userId: number, tx: Tx = prisma): Promise<void> {
  await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
}
