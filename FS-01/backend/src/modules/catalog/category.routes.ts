import { Router } from "express";
import { z } from "zod";
import { cached, cacheKeys, invalidate, invalidatePrefix } from "../../lib/cache.js";
import { uniqueSlug } from "../../lib/slug.js";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, entityId, patchSchema, validateBody } from "../../middleware/validate.js";
import type { RouteContext } from "../context.js";
import { isNotFound, prisma } from "../../lib/db.js";
import { buildTree, type CategoryNode } from "./category.model.js";

const createSchema = z.object({
  name: z.string().trim().min(2, "Name needs at least 2 characters").max(60),
  // Empty for a department; a department's id for a sub-category.
  parentId: entityId.nullable().default(null),
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
    const { value, hit } = await cached<CategoryNode[]>(ctx.redis, cacheKeys.categories, async () => buildTree(await prisma.category.findMany()));
    res.set("X-Cache", hit ? "HIT" : "MISS").json({ items: value });
  });

  // Every category, including hidden ones, with how many products use it.
  router.get("/admin/categories", ...adminOnly, async (_req, res) => {
    const categories = await prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
    });
    res.json({
      items: categories.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        parentId: c.parentId,
        commissionRateBp: c.commissionRateBp,
        isActive: c.isActive,
        sortOrder: c.sortOrder,
        productCount: c._count.products,
      })),
    });
  });

  router.post("/admin/categories", ...adminOnly, validateBody(createSchema), async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;
    if (body.parentId) {
      const parent = await prisma.category.findUnique({ where: { id: body.parentId } });
      if (!parent) throw invalidField("parentId", "Parent category not found");
      if (parent.parentId) throw invalidField("parentId", "Categories go two levels deep: pick a top-level department");
    }
    const slug = await uniqueSlug(body.name, async (s) => (await prisma.category.count({ where: { slug: s } })) > 0);
    const category = await prisma.category.create({ data: { ...body, slug } });
    await forgetCategories();
    res.status(201).json({ category: { id: category.id, name: category.name, slug: category.slug } });
  });

  router.patch("/admin/categories/:id", ...adminOnly, validateBody(updateSchema), async (req, res) => {
    const [category] = await prisma.category.updateManyAndReturn({
      where: { id: idParam(req) },
      data: req.body as z.infer<typeof updateSchema>,
    });
    if (!category) throw new AppError(404, "not_found", "Category not found");
    await forgetCategories();
    // Renaming or hiding a category changes what search shows and finds.
    await ctx.searchSync.category(category.id);
    res.json({ category: { id: category.id, name: category.name, slug: category.slug, isActive: category.isActive } });
  });

  // Only an empty category can be deleted; one in use can be hidden instead (isActive: false).
  router.delete("/admin/categories/:id", ...adminOnly, async (req, res) => {
    const id = idParam(req);
    const [children, products] = await Promise.all([
      prisma.category.count({ where: { parentId: id } }),
      prisma.product.count({ where: { categoryId: id } }),
    ]);
    if (children > 0 || products > 0) {
      throw new AppError(409, "category_in_use", "This category still has sub-categories or products. Hide it instead.", {
        subCategories: children,
        products,
      });
    }
    await prisma.category.delete({ where: { id } }).catch((err: unknown) => {
      throw isNotFound(err) ? new AppError(404, "not_found", "Category not found") : err;
    });
    await forgetCategories();
    res.status(204).end();
  });

  return router;
}
