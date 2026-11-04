import { useQuery } from "@tanstack/react-query";
import { queryString, type OwnStore, type Page, type StoreStatus } from "./catalog";
import { api } from "./client";

export interface AdminVendor extends OwnStore {
  owner: { id: string; name: string; email: string } | null;
  productCount: number;
}

export type AdminVendorList = Page<AdminVendor> & { counts: Record<StoreStatus, number> };

export type VendorAction = "approve" | "reject" | "suspend" | "restore";

export const useAdminVendors = (params: { status?: StoreStatus; page?: number }) =>
  useQuery({
    queryKey: ["admin", "vendors", params],
    queryFn: () => api<AdminVendorList>(`/admin/vendors${queryString({ ...params })}`),
    placeholderData: (previous) => previous,
  });

export const vendorAction = (id: string, action: VendorAction, reason?: string) =>
  api<{ store: OwnStore }>(`/admin/vendors/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });

export interface AdminCategory {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  commissionRateBp: number | null;
  isActive: boolean;
  sortOrder: number;
  productCount: number;
}

export const useAdminCategories = () =>
  useQuery({
    queryKey: ["admin", "categories"],
    queryFn: () => api<{ items: AdminCategory[] }>("/admin/categories").then((r) => r.items),
  });

export const createCategory = (input: { name: string; parentId: string | null }) =>
  api("/admin/categories", { method: "POST", body: JSON.stringify(input) });

export const updateCategory = (id: string, input: Partial<Pick<AdminCategory, "name" | "isActive">>) =>
  api(`/admin/categories/${id}`, { method: "PATCH", body: JSON.stringify(input) });

export const deleteCategory = (id: string) => api<void>(`/admin/categories/${id}`, { method: "DELETE" });
