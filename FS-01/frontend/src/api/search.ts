import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { queryString, type ProductCard } from "./catalog";
import { api } from "./client";

export type SearchSort = "relevance" | "newest" | "price_asc" | "price_desc" | "rating";

export const SEARCH_SORT_LABELS: Record<SearchSort, string> = {
  relevance: "Best match",
  newest: "Newest",
  price_asc: "Price: low to high",
  price_desc: "Price: high to low",
  rating: "Top rated",
};

// What the search page shows; prices in paise, as the API takes them.
export interface SearchFilters {
  q?: string;
  category?: string;
  brand?: string[];
  vendor?: string;
  minPrice?: number;
  maxPrice?: number;
  rating?: number;
  inStock?: boolean;
  sort?: SearchSort;
  page?: number;
}

export interface SearchFacets {
  categories: { slug: string; name: string; count: number }[];
  brands: { value: string; count: number }[];
  vendors: { slug: string; name: string; count: number }[];
  price: { key: string; min: number | null; max: number | null; count: number }[];
  rating: { min: number; count: number }[];
  inStock: number;
}

export interface SearchResult {
  items: ProductCard[];
  page: number;
  limit: number;
  total: number;
  facets: SearchFacets;
  matchedAllWords: boolean;
  tookMs: number;
}

export function searchPath(f: SearchFilters, limit = 24): string {
  const params = new URLSearchParams(
    queryString({
      q: f.q,
      category: f.category,
      vendor: f.vendor,
      minPrice: f.minPrice,
      maxPrice: f.maxPrice,
      rating: f.rating,
      inStock: f.inStock ? "true" : undefined,
      sort: f.sort,
      page: f.page,
      limit,
    }).slice(1),
  );
  for (const b of f.brand ?? []) params.append("brand", b);
  return `/search?${params.toString()}`;
}

export const useSearch = (filters: SearchFilters) =>
  useQuery({
    queryKey: ["search", filters],
    queryFn: () => api<SearchResult>(searchPath(filters)),
    // Keep showing the last results while the next ones load, so the page doesn't flash.
    placeholderData: (previous) => previous,
  });

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

// Title suggestions while typing: waits for a 200 ms pause and at least 2 characters.
export function useSuggestions(text: string) {
  const q = useDebounced(text.trim(), 200);
  return useQuery({
    queryKey: ["suggest", q],
    queryFn: () => api<{ items: { id: string; title: string }[] }>(`/search/suggest${queryString({ q })}`).then((r) => r.items),
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
}
