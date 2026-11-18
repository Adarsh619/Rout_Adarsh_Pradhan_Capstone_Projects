import { isIP } from "node:net";
import type { Request } from "express";
import type { Unit } from "../../lib/db.js";
import { emit } from "../integrations/events.js";
import type { Entity } from "./entities.js";

// The audit log: an append-only record of who changed what in a workspace. Entries are only ever created here
// (there is no update or delete route), and they are written in the same transaction as the change they describe.

export type Changes = Record<string, unknown>;

type Plain = string | number | boolean | null;
const plain = (v: unknown): Plain => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return v.toISOString().endsWith("T00:00:00.000Z") ? v.toISOString().slice(0, 10) : v.toISOString();
  return String(v);
};

// { field: [old, new] } for the fields in `data` whose value differs from `before`.
export function diff(before: Record<string, unknown>, data: Record<string, unknown>): Record<string, [Plain, Plain]> {
  const changes: Record<string, [Plain, Plain]> = {};
  for (const [field, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const [a, b] = [plain(before[field]), plain(value)];
    if (a !== b) changes[field] = [a, b];
  }
  return changes;
}

// The caller's IP address as seen by the outermost proxy we trust (Express applies TRUSTED_PROXY_COUNT through
// "trust proxy"; with 0 the X-Forwarded-For header, which browsers can set, is ignored).
export function clientIp(req: Request): string | null {
  let ip = req.ip ?? null;
  if (ip?.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return ip && isIP(ip) ? ip : null;
}

interface RecordOptions {
  // Also send the event to the workspace's webhooks (default true).
  emitEvent?: boolean;
  // For routes that aren't tenant-scoped (the workspace list), where req.workspace is unset.
  workspaceId?: number;
}

// Write an audit entry for the signed-in user's change and (by default) fan the event out to webhooks.
export async function record(
  unit: Unit,
  req: Request,
  action: string,
  target: Entity,
  changes: Changes = {},
  { emitEvent = true, workspaceId }: RecordOptions = {},
) {
  const wsId = workspaceId ?? req.workspace!.id;
  const actor = req.user ?? null;
  const entry = await unit.tx.auditLog.create({
    data: {
      workspaceId: wsId,
      actorId: actor?.id ?? null,
      actorEmail: actor?.email ?? "",
      action,
      entityType: target.type,
      entityId: String(target.id),
      entityLabel: target.label,
      changes: changes as object,
      ipAddress: clientIp(req),
    },
  });
  if (emitEvent) {
    await emit(unit, wsId, action, {
      entity: { type: entry.entityType, id: entry.entityId, label: entry.entityLabel },
      changes: entry.changes,
      actor: actor?.email ?? null,
    });
  }
  return entry;
}

// Audit a change made by the system rather than a person (e.g. a Stripe webhook): no actor, no IP, no webhook.
export async function recordSystem(unit: Unit, workspaceId: number, action: string, target: Entity, changes: Changes = {}) {
  return unit.tx.auditLog.create({
    data: {
      workspaceId,
      action,
      entityType: target.type,
      entityId: String(target.id),
      entityLabel: target.label,
      changes: changes as object,
    },
  });
}
