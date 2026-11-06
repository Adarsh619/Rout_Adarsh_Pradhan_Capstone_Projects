import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { queryString, type Page } from "./catalog";
import { api } from "./client";

export interface Review {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  authorName: string;
  verified: boolean;
  createdAt: string;
}

export interface ReviewPage extends Page<Review> {
  summary: { ratingAvg: number; ratingCount: number; stars: Record<"1" | "2" | "3" | "4" | "5", number> };
  // Only for a signed-in customer: may they review, and their own review if they wrote one.
  viewer: { canReview: boolean; reason: "already_reviewed" | "not_delivered" | null; mine: Review | null } | null;
}

export const reviewsKey = (productId: string) => ["reviews", productId];

export function useReviews(productId: string, page: number) {
  const { status, user } = useAuth();
  return useQuery({
    queryKey: [...reviewsKey(productId), page, user?.id ?? "guest"],
    queryFn: () => api<ReviewPage>(`/products/${productId}/reviews${queryString({ page, limit: 5 })}`),
    enabled: status !== "loading",
    placeholderData: (previous) => previous,
  });
}

export const postReview = (productId: string, input: { rating: number; title: string; body: string }) =>
  api<{ review: Review; summary: { ratingAvg: number; ratingCount: number } }>(`/products/${productId}/reviews`, {
    method: "POST",
    body: JSON.stringify(input),
  });
