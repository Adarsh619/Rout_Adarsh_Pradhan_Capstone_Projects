import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ROLES = ["customer", "vendor", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const MAX_ADDRESSES = 5;

// A delivery address. Checkout copies it into the order, so later edits never change a placed order.
const addressSchema = new Schema({
  label: { type: String, trim: true, maxlength: 30 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  phone: { type: String, required: true },
  line1: { type: String, required: true, trim: true, maxlength: 120 },
  line2: { type: String, trim: true, maxlength: 120 },
  city: { type: String, required: true, trim: true, maxlength: 60 },
  state: { type: String, required: true, trim: true, maxlength: 60 },
  pincode: { type: String, required: true },
  isDefault: { type: Boolean, default: false },
});

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 80 },
    // Stored lower-case so sign-in works whatever case the user types.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    // Never returned unless a query asks for it with .select("+passwordHash").
    passwordHash: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
    passwordChangedAt: { type: Date },
    lastLoginAt: { type: Date },
    addresses: { type: [addressSchema], default: [] },
  },
  { timestamps: true },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const User = model("User", userSchema);

// The only shape of a user the API ever sends to a browser.
export interface PublicUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: string;
}

export const toPublicUser = (u: UserDoc): PublicUser => ({
  id: u.id as string,
  name: u.name,
  email: u.email,
  role: u.role as Role,
  status: u.status as "active" | "suspended",
  createdAt: (u.createdAt as Date).toISOString(),
});

export type AddressDoc = UserDoc["addresses"][number];

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

export const toAddress = (a: AddressDoc): Address => ({
  id: a._id.toString(),
  label: a.label ?? null,
  name: a.name,
  phone: a.phone,
  line1: a.line1,
  line2: a.line2 ?? null,
  city: a.city,
  state: a.state,
  pincode: a.pincode,
  isDefault: a.isDefault,
});
