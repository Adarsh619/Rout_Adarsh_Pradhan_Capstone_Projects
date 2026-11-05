import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../middleware/errors.js";
import { idParam, patchSchema, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { MAX_ADDRESSES, toAddress, User, type UserDoc } from "../users/user.model.js";

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

  const load = async (id: string): Promise<UserDoc> => {
    const user = await User.findById(id);
    if (!user) throw new AppError(404, "not_found", "Account not found");
    return user;
  };
  const makeDefault = (user: UserDoc, addressId: string) => {
    for (const a of user.addresses) a.isDefault = a._id.toString() === addressId;
  };
  const list = (user: UserDoc) => ({ items: user.addresses.map(toAddress) });

  router.get("/account/addresses", ctx.signedIn, async (req, res) => {
    res.json(list(await load(req.auth!.id)));
  });

  router.post("/account/addresses", ctx.signedIn, validateBody(createSchema), async (req, res) => {
    const user = await load(req.auth!.id);
    if (user.addresses.length >= MAX_ADDRESSES) {
      throw new AppError(409, "too_many_addresses", `You can save up to ${MAX_ADDRESSES} addresses. Remove one first.`);
    }
    const body = req.body as z.infer<typeof createSchema>;
    user.addresses.push(body);
    const added = user.addresses[user.addresses.length - 1]!;
    if (body.isDefault || user.addresses.length === 1) makeDefault(user, added._id.toString());
    await user.save();
    res.status(201).json({ address: toAddress(added), ...list(user) });
  });

  router.patch("/account/addresses/:id", ctx.signedIn, validateBody(updateSchema), async (req, res) => {
    const user = await load(req.auth!.id);
    const id = idParam(req);
    const address = user.addresses.id(id);
    if (!address) throw new AppError(404, "not_found", "Address not found");
    const changes = req.body as z.infer<typeof updateSchema>;
    const { isDefault, ...fields } = changes;
    address.set(fields);
    if ("label" in changes && !changes.label) address.label = undefined;
    if ("line2" in changes && !changes.line2) address.line2 = undefined;
    // The default can be moved to another address but not simply switched off.
    if (isDefault) makeDefault(user, id);
    await user.save();
    res.json({ address: toAddress(address), ...list(user) });
  });

  router.delete("/account/addresses/:id", ctx.signedIn, async (req, res) => {
    const user = await load(req.auth!.id);
    const address = user.addresses.id(idParam(req));
    if (!address) throw new AppError(404, "not_found", "Address not found");
    const wasDefault = address.isDefault;
    address.deleteOne();
    if (wasDefault && user.addresses[0]) user.addresses[0].isDefault = true;
    await user.save();
    res.json(list(user));
  });

  return router;
}
