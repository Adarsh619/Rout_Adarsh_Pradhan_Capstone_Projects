import { Router } from "express";
import { z } from "zod";
import { requireRole } from "../../middleware/auth.js";
import { AppError } from "../../middleware/errors.js";
import { idParam, pageQuery, parseQuery, validateBody } from "../../middleware/validate.js";
import { Product } from "../catalog/product.model.js";
import type { RouteContext } from "../context.js";
import { SubOrder } from "../orders/order.model.js";
import { User } from "../users/user.model.js";
import { refreshRatings } from "./ratings.js";
import { Review, toPublicReview } from "./review.model.js";

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
    SubOrder.findOne({ customerId: userId, status: "delivered", "items.productId": productId }).sort({ deliveredAt: -1 });

  // Visible reviews, newest first, with the star breakdown. A signed-in customer also learns whether they may review.
  router.get("/products/:id/reviews", ctx.maybeSignedIn, async (req, res) => {
    const productId = idParam(req);
    const q = parseQuery(pageQuery, req);
    const product = await Product.findById(productId).select("ratingAvg ratingCount");
    if (!product) throw new AppError(404, "not_found", "Product not found");
    const filter = { productId, status: "visible" as const };
    const [reviews, total, stars] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Review.countDocuments(filter),
      Review.aggregate<{ _id: number; n: number }>([{ $match: { productId: product._id, status: "visible" } }, { $group: { _id: "$rating", n: { $sum: 1 } } }]),
    ]);

    let viewer: { canReview: boolean; reason: string | null; mine: ReturnType<typeof toPublicReview> | null } | null = null;
    if (req.auth?.role === "customer") {
      const mine = await Review.findOne({ productId, userId: req.auth.id });
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
        stars: Object.fromEntries([5, 4, 3, 2, 1].map((s) => [s, stars.find((x) => x._id === s)?.n ?? 0])),
      },
      viewer,
    });
  });

  router.post("/products/:id/reviews", ctx.signedIn, requireRole("customer"), validateBody(reviewSchema), async (req, res) => {
    const productId = idParam(req);
    const product = await Product.findById(productId).select("vendorId");
    if (!product) throw new AppError(404, "not_found", "Product not found");
    const part = await deliveredPart(req.auth!.id, productId);
    if (!part) throw new AppError(403, "not_delivered", "You can review a product once an order with it has been delivered to you.");
    const user = await User.findById(req.auth!.id).select("name");
    const body = req.body as z.infer<typeof reviewSchema>;
    const review = await Review.create({
      productId,
      vendorId: product.vendorId,
      userId: req.auth!.id,
      subOrderId: part._id,
      authorName: user?.name ?? "Customer",
      rating: body.rating,
      title: body.title,
      body: body.body,
    }).catch((err: unknown) => {
      if ((err as { code?: number }).code === 11000) throw new AppError(409, "already_reviewed", "You've already reviewed this product.");
      throw err;
    });
    const summary = await refreshRatings(deps, product._id, product.vendorId);
    res.status(201).json({ review: toPublicReview(review), summary });
  });

  // ---- Moderation --------------------------------------------------------------------------------

  const adminOnly = [ctx.signedIn, requireRole("admin")];

  router.get("/admin/reviews", ...adminOnly, async (req, res) => {
    const q = parseQuery(adminListQuery, req);
    const filter = q.status ? { status: q.status } : {};
    const [reviews, total] = await Promise.all([
      Review.find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip((q.page - 1) * q.limit)
        .limit(q.limit),
      Review.countDocuments(filter),
    ]);
    const products = await Product.find({ _id: { $in: reviews.map((r) => r.productId) } }).select("title");
    res.json({
      items: reviews.map((r) => ({
        ...toPublicReview(r),
        status: r.status,
        hiddenReason: r.hiddenReason ?? null,
        product: { id: r.productId.toString(), title: products.find((p) => p._id.equals(r.productId))?.title ?? "(deleted product)" },
      })),
      page: q.page,
      limit: q.limit,
      total,
    });
  });

  // Hiding a review takes it off the product page and out of the product's and store's ratings at once.
  router.patch("/admin/reviews/:id", ...adminOnly, validateBody(moderateSchema), async (req, res) => {
    const body = req.body as z.infer<typeof moderateSchema>;
    const review = await Review.findById(idParam(req));
    if (!review) throw new AppError(404, "not_found", "Review not found");
    review.status = body.status;
    review.hiddenReason = body.status === "hidden" ? body.reason : undefined;
    await review.save();
    await refreshRatings(deps, review.productId, review.vendorId);
    res.json({ review: { ...toPublicReview(review), status: review.status, hiddenReason: review.hiddenReason ?? null } });
  });

  return router;
}
