import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export interface Page<T> {
  items: T[];
  page: number;
  limit: number;
  total: number;
}

export interface CategoryNode {
  id: string;
  name: string;
  slug: string;
  children: CategoryNode[];
}

export interface Image {
  url: string;
  alt: string;
}

export interface ProductCard {
  id: string;
  title: string;
  brand: string | null;
  image: Image | null;
  price: number;
  mrp: number;
  discountPercent: number;
  inStock: boolean;
  ratingAvg: number;
  ratingCount: number;
  vendor: { storeName: string; slug: string };
}

export interface Product extends Omit<ProductCard, "image" | "vendor"> {
  slug: string;
  description: string;
  category: { id: string; name: string; slug: string } | null;
  vendor: { id: string; storeName: string; slug: string };
  images: Image[];
  stock: number;
  attributes: Record<string, string>;
  createdAt: string;
}

export interface PublicStore {
  id: string;
  storeName: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  ratingAvg: number;
  ratingCount: number;
  since: string;
}

export type StoreStatus = "pending" | "approved" | "rejected" | "suspended";

export interface OwnStore extends PublicStore {
  logoKey: string | null;
  status: StoreStatus;
  rejectionReason: string | null;
  contactEmail: string;
  phone: string;
  gstin: string | null;
  commissionRateBp: number | null;
  submittedAt: string;
  approvedAt: string | null;
  // Where earnings are paid; only the last 4 digits of the account are ever stored.
  payout: { accountHolder: string; bankLast4: string; ifsc: string; provider: string } | null;
}

export type ProductStatus = "draft" | "active" | "inactive";

export interface VendorProduct {
  id: string;
  title: string;
  slug: string;
  description: string;
  brand: string | null;
  categoryId: string;
  images: { key: string; alt: string; url: string }[];
  price: number;
  mrp: number;
  stock: number;
  sku: string | null;
  attributes: Record<string, string>;
  status: ProductStatus;
  soldCount: number;
  ratingAvg: number;
  ratingCount: number;
  createdAt: string;
  updatedAt: string;
}

export type Sort = "newest" | "price_asc" | "price_desc" | "rating";

export const SORT_LABELS: Record<Sort, string> = {
  newest: "Newest",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  rating: "Top rated",
};

// "?page=2&sort=rating" from an object, leaving out empty values; "" when there are none.
export function queryString(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .map(([k, v]) => [k, String(v)]),
  ).toString();
  return s ? `?${s}` : "";
}

// Categories rarely change, so they're kept for 5 minutes (the API caches them for the same time).
export const useCategories = () =>
  useQuery({
    queryKey: ["categories"],
    queryFn: () => api<{ items: CategoryNode[] }>("/categories").then((r) => r.items),
    staleTime: 5 * 60_000,
  });

export interface BrowseParams {
  category?: string;
  sort?: Sort;
  page?: number;
  limit?: number;
}

export const useProducts = (params: BrowseParams) =>
  useQuery({
    queryKey: ["products", params],
    queryFn: () => api<Page<ProductCard>>(`/products${queryString({ ...params })}`),
    placeholderData: (previous) => previous,
  });

export const useProduct = (id: string) =>
  useQuery({ queryKey: ["product", id], queryFn: () => api<{ product: Product }>(`/products/${id}`).then((r) => r.product) });

export const useStore = (slug: string, params: BrowseParams) =>
  useQuery({
    queryKey: ["store", slug, params],
    queryFn: () => api<{ store: PublicStore; products: Page<ProductCard> }>(`/stores/${slug}${queryString({ ...params })}`),
    placeholderData: (previous) => previous,
  });

