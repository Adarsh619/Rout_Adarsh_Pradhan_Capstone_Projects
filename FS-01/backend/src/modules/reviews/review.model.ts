import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

// A product review. Customers can only review what was delivered to them, once per product; the delivered sub-order
// is stored as proof. The demo catalogue also brings reviews from its source (source "seed", no account behind them).
const reviewSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    subOrderId: { type: Schema.Types.ObjectId, ref: "SubOrder" },
    // Shown with the review; kept as written so a later name change doesn't rewrite old reviews.
    authorName: { type: String, required: true, maxlength: 80 },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, trim: true, maxlength: 120 },
    body: { type: String, trim: true, maxlength: 2000, default: "" },
    status: { type: String, enum: ["visible", "hidden"], default: "visible" },
    source: { type: String, enum: ["customer", "seed"], default: "customer" },
    hiddenReason: { type: String, maxlength: 300 },
  },
  { timestamps: true },
);

// One review per customer per product (seeded reviews have no account, so they're not counted).
reviewSchema.index({ productId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $type: "objectId" } } });
reviewSchema.index({ productId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ vendorId: 1, status: 1 });
reviewSchema.index({ status: 1, createdAt: -1 });

export type ReviewDoc = HydratedDocument<InferSchemaType<typeof reviewSchema>>;
export const Review = model("Review", reviewSchema);

export const toPublicReview = (r: ReviewDoc) => ({
  id: r.id as string,
  rating: r.rating,
  title: r.title ?? null,
  body: r.body,
  authorName: r.authorName,
  // "Verified purchase": written by a customer whose order was delivered.
  verified: r.source === "customer",
  createdAt: (r.createdAt as Date).toISOString(),
});
