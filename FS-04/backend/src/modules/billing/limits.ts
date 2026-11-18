import { lockRow, type Tx } from "../../lib/db.js";
import { paymentRequired } from "../../lib/errors.js";
import { effectivePlan, PLANS, type Resource } from "./plans.js";

export async function usage(tx: Tx, workspaceId: number): Promise<Record<Resource, number>> {
  const [projects, members, issues] = await Promise.all([
    tx.project.count({ where: { workspaceId } }),
    tx.membership.count({ where: { workspaceId } }),
    tx.issue.count({ where: { workspaceId } }),
  ]);
  return { projects, members, issues };
}

export async function subscriptionOf(tx: Tx, workspaceId: number) {
  return tx.subscription.upsert({ where: { workspaceId }, update: {}, create: { workspaceId } });
}

// 402 if the workspace's plan has no room for one more `resource`.
// Call it inside the transaction that creates the item: it locks the subscription row, so two requests creating at
// the same moment are counted one after the other instead of both seeing room for one.
export async function enforceLimit(tx: Tx, workspaceId: number, resource: Resource): Promise<void> {
  const sub = await subscriptionOf(tx, workspaceId);
  await lockRow(tx, "subscriptions", sub.id);
  const plan = effectivePlan(sub);
  const limit = PLANS[plan].limits[resource];
  if (limit === null) return;
  const used = (await usage(tx, workspaceId))[resource];
  if (used >= limit) {
    throw paymentRequired(`Your ${PLANS[plan].name} plan allows ${limit} ${resource}. Upgrade to add more.`);
  }
}
