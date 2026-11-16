import type { Address as AddressRow, User as UserRow } from "../../generated/prisma/client.js";

export const ROLES = ["customer", "vendor", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const MAX_ADDRESSES = 5;

export type { UserRow, AddressRow };

// Never send passwordHash: every query that returns a user to a route selects these columns.
export const publicUserSelect = { id: true, name: true, email: true, role: true, status: true, createdAt: true } as const;

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: string;
}

export const toPublicUser = (u: Pick<UserRow, "id" | "name" | "email" | "role" | "status" | "createdAt">): PublicUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  status: u.status,
  createdAt: u.createdAt.toISOString(),
});

export interface Address {
  id: string;
  label: string | null;
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  pincode: string;
  isDefault: boolean;
}

export const toAddress = (a: AddressRow): Address => ({
  id: a.id,
  label: a.label,
  name: a.name,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2,
  city: a.city,
  state: a.state,
  pincode: a.pincode,
  isDefault: a.isDefault,
});
