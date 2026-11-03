import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";

export const ROLES = ["customer", "vendor", "admin"] as const;
export type Role = (typeof ROLES)[number];

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
