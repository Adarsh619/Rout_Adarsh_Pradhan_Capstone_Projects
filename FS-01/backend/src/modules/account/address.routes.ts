import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../middleware/errors.js";
import { idParam, patchSchema, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { prisma, type Tx } from "../../lib/db.js";
import { inTransaction } from "../../lib/transaction.js";
import { MAX_ADDRESSES, toAddress } from "../users/user.model.js";

const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || undefined)
    .optional();

// Indian numbers: 10 digits starting 6–9, with or without +91, spaces or dashes. Stored as the 10 digits.
const phone = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, "").replace(/^(\+91|0)/, ""))
  .refine((s) => /^[6-9]\d{9}$/.test(s), "Enter a 10-digit mobile number");

const addressFields = {
  label: optional(30),
  name: z.string().trim().min(2, "Enter the recipient's name").max(80),
  phone,
  line1: z.string().trim().min(3, "Enter the house number and street").max(120),
  line2: optional(120),
  city: z.string().trim().min(2, "Enter the city").max(60),
  state: z.string().trim().min(2, "Enter the state").max(60),
  pincode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, "Enter a 6-digit PIN code"),
  isDefault: z.boolean().default(false),
};
const createSchema = z.object(addressFields);
const updateSchema = patchSchema(addressFields);

// The user's saved delivery addresses (up to 5). Exactly one is the default whenever any exist.
export function addressRouter(ctx: RouteContext): Router {
  const router = Router();

  // Oldest first, as they were added.
  const list = async (userId: string, tx: Tx = prisma) => ({
    items: (await tx.address.findMany({ where: { userId }, orderBy: { id: "asc" } })).map(toAddress),
  });
  const makeDefault = (tx: Tx, userId: string, addressId: string) =>
    tx.$executeRaw`UPDATE addresses SET "isDefault" = (id = ${addressId}::uuid) WHERE "userId" = ${userId}::uuid`;
  const find = async (tx: Tx, userId: string, id: string) => {
    const address = await tx.address.findFirst({ where: { id, userId } });
    if (!address) throw new AppError(404, "not_found", "Address not found");
    return address;
  };

  router.get("/account/addresses", ctx.signedIn, async (req, res) => {
    res.json(await list(req.auth!.id));
  });

  router.post("/account/addresses", ctx.signedIn, validateBody(createSchema), async (req, res) => {
    const userId = req.auth!.id;
    const { isDefault, ...fields } = req.body as z.infer<typeof createSchema>;
    const result = await inTransaction(async (tx) => {
      // Locks the user's row, so two tabs adding at once can't both get past the limit.
      await tx.$executeRaw`SELECT 1 FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
      const count = await tx.address.count({ where: { userId } });
      if (count >= MAX_ADDRESSES) {
        throw new AppError(409, "too_many_addresses", `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`);
      }
      const added = await tx.address.create({ data: { ...fields, userId } });
      if (isDefault || count === 0) await makeDefault(tx, userId, added.id);
      return { address: await tx.address.findUniqueOrThrow({ where: { id: added.id } }), ...(await list(userId, tx)) };
    });
    res.status(201).json({ address: toAddress(result.address), items: result.items });
  });

  router.patch("/account/addresses/:id", ctx.signedIn, validateBody(updateSchema), async (req, res) => {
    const userId = req.auth!.id;
    const id = idParam(req);
    const changes = req.body as z.infer<typeof updateSchema>;
    const { isDefault, ...fields } = changes;
    const result = await inTransaction(async (tx) => {
      await find(tx, userId, id);
      await tx.address.update({
        where: { id },
        data: {
          ...fields,
          ...("label" in changes && !changes.label && { label: null }),
          ...("line2" in changes && !changes.line2 && { line2: null }),
        },
      });
      // The default can be moved to another address but not simply switched off.
      if (isDefault) await makeDefault(tx, userId, id);
      return { address: await tx.address.findUniqueOrThrow({ where: { id } }), ...(await list(userId, tx)) };
    });
    res.json({ address: toAddress(result.address), items: result.items });
  });

  router.delete("/account/addresses/:id", ctx.signedIn, async (req, res) => {
    const userId = req.auth!.id;
    const id = idParam(req);
    const result = await inTransaction(async (tx) => {
      const address = await find(tx, userId, id);
      await tx.address.delete({ where: { id } });
      if (address.isDefault) {
        const first = await tx.address.findFirst({ where: { userId }, orderBy: { id: "asc" } });
        if (first) await makeDefault(tx, userId, first.id);
      }
      return list(userId, tx);
    });
    res.json(result);
  });

  return router;
}
