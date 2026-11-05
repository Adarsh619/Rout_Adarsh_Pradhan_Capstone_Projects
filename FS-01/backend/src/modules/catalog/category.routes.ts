import { Router } from "express";
import { z } from "zod";
import { cached, cacheKeys, invalidate, invalidatePrefix } from "../../lib/cache.js";
import { uniqueSlug } from "../../lib/slug.js";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, objectId, patchSchema, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { buildTree, Category, type CategoryNode } from "./category.model.js";
import { Product } from "./product.model.js";

const createSchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters").max(60),
  // Empty for a department; a department's id for a sub-category.
  parentId: objectId.nullable().default(null),
  // 0–50%, in basis points. Empty = platform default.
  commissionRateBp: z.number().int().min(0).max(5000).nullable().default(null),
  sortOrder: z.number().int().min(0).max(1000).default(0),
});
const updateSchema = patchSchema({ ...createSchema.omit({ parentId: true }).shape, isActive: z.boolean() });

const invalidField = (field: string, message: string) =>
  new AppError(400, "validation_error", "Some fields need fixing", { fields: [{ field, message }] });

export function categoryRouter(ctx: RouteContext): Router {
  const router = Router();
  const adminOnly = [ctx.signedIn, requireRole("admin")];
  // Product pages embed the category name, so a rename or hide clears them too.
  const forgetCategories = () =>
    Promise.all([invalidate(ctx.redis, cacheKeys.categories), invalidatePrefix(ctx.redis, cacheKeys.product(""))]);

  router.get("/categories", async (_req, res) => {
    const { value, hit } = await cached<CategoryNode[]>(ctx.redis, cacheKeys.categories, async () => buildTree(await Category.find()));
    res.set("X-Cache", hit ? "HIT" : "MISS").json({ items: value });
  });

  // Every category, including hidden ones, with how many products use it.
  router.get("/admin/categories", ...adminOnly, async (_req, res) => {
    const [categories, counts] = await Promise.all([
      Category.find().sort({ sortOrder: 1, name: 1 }),
      Product.aggregate<{ _id: unknown; n: number }>([{ $group: { _id: "$categoryId", n: { $sum: 1 } } }]),
    ]);
    const byId = new Map(counts.map((c) => [String(c._id), c.n]));
    res.json({
      items: categories.map((c) => ({
        id: c.id as string,
        name: c.name,
        slug: c.slug,
        parentId: c.parentId?.toString() ?? null,
        commissionRateBp: c.commissionRateBp ?? null,
        isActive: c.isActive,
        sortOrder: c.sortOrder,
        productCount: byId.get(c.id as string) ?? 0,
      })),
    });
  });

  router.post("/admin/categories", ...adminOnly, validateBody(createSchema), async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    if (body.parentId) {
      const parent = await Category.findById(body.parentId);
      if (!parent) throw invalidField("parentId", "Parent category not found");
      if (parent.parentId) throw invalidField("parentId", "Categories go two levels deep: pick a top-level department");
    }
    const slug = await uniqueSlug(body.name, async (s) => (await Category.exists({ slug: s })) !== null);
    const category = await Category.create({ ...body, slug });
    await forgetCategories();
    res.status(201).json({ category: { id: category.id as string, name: category.name, slug: category.slug } });
  });

  router.patch("/admin/categories/:id", ...adminOnly, validateBody(updateSchema), async (req, res) => {
    const category = await Category.findByIdAndUpdate(idParam(req), req.body as z.infer<typeof updateSchema>, {
      returnDocument: "after",
      runValidators: true,
    });
    if (!category) throw new AppError(404, "not_found", "Category not found");
    await forgetCategories();
    // Renaming or hiding a category changes what search shows and finds.
    await ctx.searchSync.category(category._id);
    res.json({ category: { id: category.id as string, name: category.name, slug: category.slug, isActive: category.isActive } });
  });

  // Only an empty category can be deleted; one in use can be hidden instead (isActive: false).
  router.delete("/admin/categories/:id", ...adminOnly, async (req, res) => {
    const id = idParam(req);
    const [children, products] = await Promise.all([Category.countDocuments({ parentId: id }), Product.countDocuments({ categoryId: id })]);
    if (children > 0 || products > 0) {
      throw new AppError(409, "category_in_use", "This category still has sub-categories or products. Hide it instead.", {
        subCategories: children,
        products,
      });
    }
    const deleted = await Category.findByIdAndDelete(id);
    if (!deleted) throw new AppError(404, "not_found", "Category not found");
    await forgetCategories();
    res.status(204).end();
  });

  return router;
}
