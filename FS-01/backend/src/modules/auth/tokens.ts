import { createHash, randomBytes } from "node:crypto";
import { errors, jwtVerify, SignJWT } from "jose";
import type { Role } from "../users/user.model.js";

// Access token: a short-lived JWT the browser keeps in memory and sends as "Authorization: Bearer ...".
export interface AccessClaims {
  sub: string; // user id
  role: Role;
  sid: string; // session id, checked against Redis so logout and password changes take effect at once
}

const ISSUER = "shopsphere";
const AUDIENCE = "shopsphere-web";

export class AccessTokens {
  private readonly key: Uint8Array;

  constructor(
    secret: string,
    private readonly ttlSeconds: number,
  ) {
    this.key = new TextEncoder().encode(secret);
  }

  sign(claims: AccessClaims): Promise<string> {
    return new SignJWT({ role: claims.role, sid: claims.sid })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(claims.sub)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.ttlSeconds}s`)
      .sign(this.key);
  }

  // Returns the claims, or "expired" / "invalid" so the client knows whether refreshing can help.
  async verify(token: string): Promise<AccessClaims | "expired" | "invalid"> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        issuer: ISSUER,
        audience: AUDIENCE,
        algorithms: ["HS256"],
      });
      if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || typeof payload.role !== "string") {
        return "invalid";
      }
      return { sub: payload.sub, sid: payload.sid, role: payload.role as Role };
    } catch (err) {
      return err instanceof errors.JWTExpired ? "expired" : "invalid";
    }
  }
}

// Refresh token: "<sessionId>.<secret>", random and opaque. Only a SHA-256 hash of the secret is stored.
export const newSessionId = (): string => randomBytes(16).toString("base64url");
export const newRefreshSecret = (): string => randomBytes(32).toString("base64url");
export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("base64url");

export function parseRefreshToken(token: string | undefined): { sid: string; secret: string } | undefined {
  if (!token) return undefined;
  const [sid, secret, extra] = token.split(".");
  if (!sid || !secret || extra !== undefined || sid.length > 64 || secret.length > 128) return undefined;
  return { sid, secret };
}
