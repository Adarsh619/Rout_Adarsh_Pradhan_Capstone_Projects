import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "../auth/AuthContext";
import { api } from "./client";

export type LineProblem = "unavailable" | "out_of_stock" | "not_enough_stock";

export interface CartItem {
  productId: string;
  title: string;
  image: { url: string; alt: string } | null;
  price: number;
  mrp: number;
  qty: number;
  stock: number;
  lineTotal: number;
  problem: LineProblem | null;
}

export interface Cart {
  groups: { vendor: { id: string; storeName: string; slug: string }; items: CartItem[]; subtotal: number }[];
  itemCount: number;
  itemsTotal: number;
  problems: number;
  canCheckout: boolean;
  coupon: { code: string; description: string | null; scope: "platform" | "vendor"; storeName: string | null } | null;
  // Why the applied coupon doesn't apply right now (e.g. the cart dropped below its minimum).
  couponProblem: string | null;
  discount: number;
  grandTotal: number;
}

export const MAX_LINE_QTY = 10;

export const PROBLEM_TEXT: Record<LineProblem, string> = {
  unavailable: "No longer available. Remove it to continue.",
  out_of_stock: "Out of stock. Remove it to continue.",
  not_enough_stock: "Not enough in stock for this quantity.",
};

// Guests and signed-in users have different carts (the guest's merges into the account at sign-in),
// so the query key includes who is asking.
export function useCartKey() {
  const { status, user } = useAuth();
  return ["cart", status === "signedIn" ? user?.id : "guest"] as const;
}

export function useCart() {
  const { status } = useAuth();
  const key = useCartKey();
  return useQuery({
    queryKey: key,
    queryFn: () => api<{ cart: Cart }>("/cart").then((r) => r.cart),
    // Wait until we know whether someone is signed in, or the guest cart would be fetched first.
    enabled: status !== "loading",
  });
}

// Every cart change answers with the whole updated cart, which replaces the cached one.
function useCartMutation<V>(send: (vars: V) => Promise<{ cart: Cart }>) {
  const client = useQueryClient();
  const key = useCartKey();
  return useMutation({
    mutationFn: send,
    onSuccess: (r) => client.setQueryData(key, r.cart),
  });
}

export const useAddToCart = () =>
  useCartMutation(({ productId, qty }: { productId: string; qty: number }) =>
    api<{ cart: Cart }>("/cart/items", { method: "POST", body: JSON.stringify({ productId, qty }) }),
  );

export const useSetCartQty = () =>
  useCartMutation(({ productId, qty }: { productId: string; qty: number }) =>
    api<{ cart: Cart }>(`/cart/items/${productId}`, { method: "PATCH", body: JSON.stringify({ qty }) }),
  );

export const useApplyCoupon = () =>
  useCartMutation((code: string) => api<{ cart: Cart }>("/cart/coupon", { method: "POST", body: JSON.stringify({ code }) }));

export const useRemoveCoupon = () => useCartMutation(() => api<{ cart: Cart }>("/cart/coupon", { method: "DELETE" }));

export const useRemoveFromCart = () =>
  useCartMutation((productId: string) => api<{ cart: Cart }>(`/cart/items/${productId}`, { method: "DELETE" }));
