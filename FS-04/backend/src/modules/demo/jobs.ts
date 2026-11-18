import { config } from "../../config.js";
import { prisma } from "../../lib/db.js";
import { logger } from "../../lib/logger.js";
import { DEMO_WORKSPACES, isDemoAccount } from "../auth/demo.js";
import { deleteWorkspace } from "../tenancy/services.js";
import { seedDemo } from "./seed.js";

// Housekeeping for the public demo site. Both jobs do nothing unless DEMO_MODE is on.

// Rebuild the demo companies every night, so whatever visitors changed is gone for the next person.
export async function resetDemoData({ issues = 60 }: { issues?: number } = {}): Promise<string> {
  if (!config.DEMO_MODE) return "skipped: DEMO_MODE is off";
  await seedDemo({ issues, reset: true, force: true });
  return `demo reset; ${await purgeVisitorData()}`;
}

// Delete workspaces and accounts that visitors created more than DEMO_VISITOR_RETENTION_DAYS ago.
export async function purgeVisitorData(): Promise<string> {
  if (!config.DEMO_MODE) return "skipped: DEMO_MODE is off";
  const cutoff = new Date(Date.now() - config.DEMO_VISITOR_RETENTION_DAYS * 86_400_000);
  const old = await prisma.workspace.findMany({
    where: { slug: { notIn: [...DEMO_WORKSPACES] }, createdAt: { lt: cutoff } },
    select: { id: true },
  });
  for (const w of old) await deleteWorkspace(w.id);
  const stale = await prisma.user.findMany({
    where: { dateJoined: { lt: cutoff }, isStaff: false, memberships: { none: {} }, ownedWorkspaces: { none: {} } },
  });
  let users = 0;
  for (const user of stale) {
    if (isDemoAccount(user)) continue;
    try {
      await prisma.user.delete({ where: { id: user.id } });
      users++;
    } catch (err) {
      // Still referenced; it goes once that workspace is purged.
      logger.warn({ err, email: user.email }, "purge_visitor_data: kept an account");
    }
  }
  return `purged ${old.length} workspaces, ${users} accounts`;
}
