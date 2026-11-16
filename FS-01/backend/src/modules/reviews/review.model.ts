import type { Review as ReviewRow } from "../../generated/prisma/client.js";

export type { ReviewRow };

export const toPublicReview = (r: ReviewRow) => ({
  id: r.id,
  rating: r.rating,
  title: r.title,
  body: r.body,
  authorName: r.authorName,
  verified: r.source === "customer",
  createdAt: r.createdAt.toISOString(),
});
