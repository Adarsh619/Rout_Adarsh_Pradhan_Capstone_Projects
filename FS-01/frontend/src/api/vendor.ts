import { useQuery } from "@tanstack/react-query";
import { queryString, type OwnStore, type Page, type ProductStatus, type VendorProduct } from "./catalog";
import { api } from "./client";

export interface StoreInput {
  storeName: string;
  description: string;
  contactEmail: string;
  phone: string;
  gstin: string;
}

export interface ProductInput {
  title: string;
  description: string;
  brand: string;
  categoryId: string;
  price: number;
  mrp: number;
  stock: number;
  sku: string;
  attributes: Record<string, string>;
  images: { key: string; alt: string }[];
  status: ProductStatus;
}

export const myStoreKey = ["vendor", "store"];

export const useMyStore = () =>
  useQuery({ queryKey: myStoreKey, queryFn: () => api<{ store: OwnStore | null }>("/vendors/me").then((r) => r.store) });

export const applyForStore = (input: StoreInput) =>
  api<{ store: OwnStore }>("/vendors/apply", { method: "POST", body: JSON.stringify(input) }).then((r) => r.store);

export const updateStore = (input: Partial<StoreInput> & { logoKey?: string | null }) =>
  api<{ store: OwnStore }>("/vendors/me", { method: "PATCH", body: JSON.stringify(input) }).then((r) => r.store);

export type VendorProductList = Page<VendorProduct> & { counts: Record<ProductStatus, number> };

export const useMyProducts = (params: { status?: ProductStatus; q?: string; page?: number }) =>
  useQuery({
    queryKey: ["vendor", "products", params],
    queryFn: () => api<VendorProductList>(`/vendor/products${queryString({ ...params, limit: 20 })}`),
    placeholderData: (previous) => previous,
  });

export const useMyProduct = (id: string | undefined) =>
  useQuery({
    queryKey: ["vendor", "product", id],
    queryFn: () => api<{ product: VendorProduct }>(`/vendor/products/${id}`).then((r) => r.product),
    enabled: Boolean(id),
  });

export const saveProduct = (input: ProductInput, id?: string) =>
  api<{ product: VendorProduct }>(id ? `/vendor/products/${id}` : "/vendor/products", {
    method: id ? "PATCH" : "POST",
    body: JSON.stringify(input),
  }).then((r) => r.product);

export const deleteProduct = (id: string) => api<void>(`/vendor/products/${id}`, { method: "DELETE" });
