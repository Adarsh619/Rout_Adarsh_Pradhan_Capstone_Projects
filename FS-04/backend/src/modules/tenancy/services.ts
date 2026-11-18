import type { Request } from "express";
import type { Membership, User } from "../../generated/prisma/client.js";
import { isUniqueViolation, lockRow, prisma, type Tx, type Unit } from "../../lib/db.js";
import { entity } from "../audit/entities.js";
import { record } from "../audit/service.js";
import { createDefaultWorkflow } from "../tracker/services.js";
import { deleteAttachmentFiles } from "../tracker/files.js";

// Same rules as Django's slugify: ASCII letters, digits, "-" and "_", lower-case, spaces become "-".
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\p{ASCII}]/gu, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[-\s]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
}

async function uniqueSlug(tx: Tx, name: string): Promise<string> {
  const base = slugify(name).slice(0, 50) || "workspace";
  let slug = base;
  for (let i = 2; await tx.workspace.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${base}-${i}`;
  return slug;
}

const SLUG_ATTEMPTS = 5;

// A workspace with its owner membership, a default workflow and a free subscription.
// Two sign-ups with the same company name can pick the same slug at once; the unique index stops the second,
// which retries with the next free slug.
export async function createWorkspace(name: string, owner: Pick<User, "id">, slug?: string) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const ws = await tx.workspace.create({
          data: { name, slug: slug ?? (await uniqueSlug(tx, name)), ownerId: owner.id },
        });
        await tx.membership.create({ data: { workspaceId: ws.id, userId: owner.id, role: "owner" } });
        await createDefaultWorkflow(tx, ws.id);
        await tx.subscription.create({ data: { workspaceId: ws.id } });
        return ws;
      });
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= SLUG_ATTEMPTS || slug) throw err;
    }
  }
}

// Delete a tenant and all its data, including its attachment files once the delete has committed.
export async function deleteWorkspace(workspaceId: number): Promise<void> {
  const files = await prisma.attachment.findMany({ where: { workspaceId }, select: { file: true } });
  await prisma.$transaction(async (tx) => {
    // Issues and projects first: they restrict deleting the workflow and status rows they use.
    await tx.issue.deleteMany({ where: { workspaceId } });
    await tx.project.deleteMany({ where: { workspaceId } });
    await tx.workspace.delete({ where: { id: workspaceId } });
  });
  await deleteAttachmentFiles(files.map((f) => f.file));
}

// Unassign the person's open issues, audit `action`, then delete the membership. Done issues keep their
// assignee as history; notifications only go to current members, so the person hears nothing more either way.
export async function removeMember(
  unit: Unit,
  req: Request,
  membership: Membership & { user: User },
  action: "member.removed" | "member.left",
): Promise<string[]> {
  const { tx } = unit;
  const open = await tx.issue.findMany({
    where: { workspaceId: membership.workspaceId, assigneeId: membership.userId, status: { category: { not: "done" } } },
    select: { id: true, number: true, project: { select: { key: true } } },
    orderBy: [{ rank: "asc" }, { id: "asc" }],
  });
  const keys = open.map((i) => `${i.project.key}-${i.number}`);
  await tx.issue.updateMany({ where: { id: { in: open.map((i) => i.id) } }, data: { assigneeId: null } });
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: membership.workspaceId } });
  await record(unit, req, action, entity.membership(membership, membership.user.email, ws.name), {
    email: membership.user.email,
    unassigned_issues: keys,
  });
  await tx.membership.delete({ where: { id: membership.id } });
  return keys;
}

// Make another member the owner; the previous owner becomes an admin.
export async function transferOwnership(tx: Tx, workspaceId: number, newOwner: Membership): Promise<void> {
  await lockRow(tx, "workspaces", workspaceId);
  const ws = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  await tx.membership.update({
    where: { workspaceId_userId: { workspaceId, userId: ws.ownerId } },
    data: { role: "admin" },
  });
  await tx.membership.update({ where: { id: newOwner.id }, data: { role: "owner" } });
  await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: newOwner.userId } });
}
