export type Role = "customer" | "vendor" | "admin";

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: string;
}

// Where each role lands after signing in.
export const HOME_BY_ROLE: Record<Role, string> = {
  customer: "/account",
  vendor: "/vendor",
  admin: "/admin",
};

export const ROLE_LABEL: Record<Role, string> = {
  customer: "Customer",
  vendor: "Vendor",
  admin: "Admin",
};
