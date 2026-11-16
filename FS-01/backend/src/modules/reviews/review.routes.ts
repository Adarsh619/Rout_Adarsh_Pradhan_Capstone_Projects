import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, validateBody } from "../../middleware/validate.js";
import { isUniqueViolation, prisma } from "../../lib/db.js";
import type { RouteContext } from "../context.js";
import { refreshRatings } from "./ratings.js";
import { toPublicReview } from "./review.model.js";

const reviewSchema = z.object({
  rating: z.number({ error: "Choose 1 to 5 stars" }).int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"),
  title: z
    .string()
    .trim()
    .max(120)
    .transform((s) => s || undefined)
    .optional(),
  body: z.string().trim().min(10, "Write at least a sentence (10 characters)").max(2000),
});

const moderateSchema = z.object({
  status: z.enum(["visible", "hidden"]),
  reason: z.string().trim().max(300).optional(),
});

const adminListQuery = pageQuery.extend({ status: z.enum(["visible", "hidden"]).optional() });

export function reviewRouter(ctx: RouteContext): Router {
  const router = Router();
  const deps = { redis: ctx.redis, searchSync: ctx.searchSync };

  // The part of an order that proves this customer received this product, if any.
  const deliveredPart = (userId: string, productId: string) =>
    prisma.subOrder.findFirst({
      where: { customerId: userId, status: "delivered", lines: { some: { productId } } },
      orderBy: { deliveredAt: "desc" },
      select: { id: true },
    });

  // Visible reviews, newest first, with the star breakdown. A signed-in customer also learns whether they may review.
  router.get("/products/:id/reviews", ctx.maybeSignedIn, async (req, res) => {
    const productId = idParam(req);
    const q = parseQuery(pageQuery, req);
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { ratingAvg: true, ratingCount: true } });
    if (!product) throw new AppError(404, "not_found", "Product not found");
    const where = { productId, status: "visible" as const };
    const [reviews, total, stars] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
      prisma.review.count({ where }),
      prisma.review.groupBy({ by: ["rating"], where, _count: { _all: true } }),
    ]);

    let viewer: { canReview: boolean; reason: string | null; mine: ReturnType<typeof toPublicReview> | null } | null = null;
    if (req.auth?.role === "customer") {
      const mine = await prisma.review.findFirst({ where: { productId, userId: req.auth.id } });
      const delivered = mine ? null : await deliveredPart(req.auth.id, productId);
      viewer = {
        canReview: !mine && !!delivered,
        reason: mine ? "already_reviewed" : delivered ? null : "not_delivered",
        mine: mine ? toPublicReview(mine) : null,
      };
    }

    res.json({
      items: reviews.map(toPublicReview),
      page: q.page,
      limit: q.limit,
      total,
      summary: {
        ratingAvg: product.ratingAvg,
        ratingCount: product.ratingCount,
        stars: Object.fromEntries([5, 4, 3, 2, 1].map((s) => [s, stars.find((x) => x.rating === s)?._count._all ?? 0])),
      },
      viewer,
    });
  });

  router.post("/products/:id/reviews", ctx.signedIn, requireRole("customer"), validateBody(reviewSchema), async (req, res) => {
    const productId = idParam(req);
    const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, vendorId: true } });
    if (!product) throw new AppError(404, "not_found", "Product not found");
    const part = await deliveredPart(req.auth!.id, productId);
    if (!part) throw new AppError(403, "not_delivered", "You can review a product once an order with it has been delivered to you.");
    const user = await prisma.user.findUnique({ where: { id: req.auth!.id }, select: { name: true } });
    const body = req.body as z.infer<typeof reviewSchema>;
    const review = await prisma.review
      .create({
        data: {
          productId,
          vendorId: product.vendorId,
          userId: req.auth!.id,
          subOrderId: part.id,
          authorName: user?.name ?? "Customer",
          rating: body.rating,
          title: body.title,
          body: body.body,
        },
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err)) throw new AppError(409, "already_reviewed", "You've already reviewed this product.");
        throw err;
      });
    const summary = await refreshRatings(deps, product.id, product.vendorId);
    res.status(201).json({ review: toPublicReview(review), summary });
  });

  // ---- Moderation --------------------------------------------------------------------------------

  const adminOnly = [ctx.signedIn, requireRole("admin")];

  router.get("/admin/reviews", ...adminOnly, async (req, res) => {
    const q = parseQuery(adminListQuery, req);
    const where = q.status ? { status: q.status } : {};
    const [reviews, total] = await Promise.all([
      prisma.review.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { product: { select: { title: true } } },
      }),
      prisma.review.count({ where }),
    ]);
    res.json({
      items: reviews.map(({ product, ...r }) => ({
        ...toPublicReview(r),
        status: r.status,
        hiddenReason: r.hiddenReason,
        product: { id: r.productId, title: product.title },
      })),
      page: q.page,
      limit: q.limit,
      total,
    });
  });

  // Hiding a review takes it off the product page and out of the product's and store's ratings at once.
  router.patch("/admin/reviews/:id", ...adminOnly, validateBody(moderateSchema), async (req, res) => {
    const body = req.body as z.infer<typeof moderateSchema>;
    const [review] = await prisma.review.updateManyAndReturn({
      where: { id: idParam(req) },
      data: { status: body.status, hiddenReason: body.status === "hidden" ? (body.reason ?? null) : null },
    });
    if (!review) throw new AppError(404, "not_found", "Review not found");
    await refreshRatings(deps, review.productId, review.vendorId);
    res.json({ review: { ...toPublicReview(review), status: review.status, hiddenReason: review.hiddenReason } });
  });

  return router;
}
