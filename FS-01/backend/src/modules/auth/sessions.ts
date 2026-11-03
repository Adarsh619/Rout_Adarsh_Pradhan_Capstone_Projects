import type { Redis } from "ioredis";
import type { Role } from "../users/user.model.js";
import { hashSecret, newRefreshSecret, newSessionId } from "./tokens.js";

// One session per signed-in browser, kept in Redis:
//   session:<sid>        hash { uid, role, hash, prev, rotatedAt }   expires after the refresh lifetime
//   user-sessions:<uid>  set of that user's session ids, to sign out everywhere at once
// The refresh token's secret changes on every refresh (rotation). Presenting the *previous* secret again means
// a copy of the token is being used somewhere else, so the whole session is revoked.

const sessionKey = (sid: string) => `session:${sid}`;
const userKey = (uid: string) => `user-sessions:${uid}`;

// Two tabs refreshing at the same moment both send the same token; the slower one gets "race" and simply retries
// with the new cookie, instead of being treated as a stolen token.
const RACE_GRACE_MS = 15_000;

// Runs atomically inside Redis so two refreshes can never both succeed with the same secret.
const ROTATE_LUA = `
local s = redis.call('HMGET', KEYS[1], 'uid', 'role', 'hash', 'prev', 'rotatedAt')
if not s[1] then return {'missing'} end
if s[3] == ARGV[1] then
  redis.call('HSET', KEYS[1], 'prev', s[3], 'hash', ARGV[2], 'rotatedAt', ARGV[3])
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return {'ok', s[1], s[2]}
end
if s[4] == ARGV[1] then
  if tonumber(ARGV[3]) - tonumber(s[5] or '0') <= tonumber(ARGV[4]) then return {'race'} end
  redis.call('DEL', KEYS[1])
  return {'reused', s[1]}
end
return {'invalid'}
`;

export type RotateResult =
  | { status: "ok"; uid: string; role: Role; token: string }
  | { status: "missing" | "invalid" | "race" }
  | { status: "reused"; uid: string };

export class SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
  ) {}

  async create(uid: string, role: Role): Promise<{ sid: string; token: string }> {
    const sid = newSessionId();
    const secret = newRefreshSecret();
    await this.redis
      .multi()
      .hset(sessionKey(sid), { uid, role, hash: hashSecret(secret), prev: "", rotatedAt: Date.now() })
      .expire(sessionKey(sid), this.ttlSeconds)
      .sadd(userKey(uid), sid)
      .expire(userKey(uid), this.ttlSeconds)
      .exec();
    return { sid, token: `${sid}.${secret}` };
  }

  async rotate(sid: string, secret: string): Promise<RotateResult> {
    const next = newRefreshSecret();
    const res = (await this.redis.eval(
      ROTATE_LUA,
      1,
      sessionKey(sid),
      hashSecret(secret),
      hashSecret(next),
      Date.now(),
      RACE_GRACE_MS,
      this.ttlSeconds,
    )) as string[];
    switch (res[0]) {
      case "ok":
        await this.redis.expire(userKey(res[1]!), this.ttlSeconds);
        return { status: "ok", uid: res[1]!, role: res[2] as Role, token: `${sid}.${next}` };
      case "reused":
        await this.redis.srem(userKey(res[1]!), sid);
        return { status: "reused", uid: res[1]! };
      default:
        return { status: res[0] as "missing" | "invalid" | "race" };
    }
  }

  async isActive(sid: string): Promise<boolean> {
    return (await this.redis.exists(sessionKey(sid))) === 1;
  }

  async revoke(sid: string): Promise<void> {
    const uid = await this.redis.hget(sessionKey(sid), "uid");
    await this.redis.del(sessionKey(sid));
    if (uid) await this.redis.srem(userKey(uid), sid);
  }

  // Signs the user out everywhere, optionally keeping the session that made the request.
  async revokeAllForUser(uid: string, keepSid?: string): Promise<number> {
    const sids = (await this.redis.smembers(userKey(uid))).filter((s) => s !== keepSid);
    if (sids.length === 0) return 0;
    await this.redis
      .multi()
      .del(...sids.map(sessionKey))
      .srem(userKey(uid), ...sids)
      .exec();
    return sids.length;
  }
}
