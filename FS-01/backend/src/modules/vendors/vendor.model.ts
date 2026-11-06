import { model, Schema, type HydratedDocument, type InferSchemaType } from "mongoose";
import type { Storage } from "../../lib/s3.js";

export const VENDOR_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

const vendorSchema = new Schema(
  {
    // One store per vendor account.
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    storeName: { type: String, required: true, trim: true, minlength: 3, maxlength: 60 },
    // Used in store URLs (/stores/<slug>); fixed once the store is approved so shared links keep working.
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: "", maxlength: 1000 },
    logoKey: { type: String },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    phone: { type: String, required: true },
    gstin: { type: String },
    status: { type: String, enum: VENDOR_STATUSES, default: "pending", index: true },
    // Shown to the vendor when an application is rejected or a store suspended.
    rejectionReason: { type: String },
    // Overrides the category's commission when set (Day 8 admin page).
    commissionRateBp: { type: Number, default: null, min: 0, max: 5000 },
    // Where the vendor's earnings go. Only the last 4 digits of the account are kept; the full number goes to the
    // payout provider once, which hands back a beneficiary reference used for every payout.
    payout: {
      accountHolder: { type: String },
      bankLast4: { type: String },
      ifsc: { type: String },
      provider: { type: String },
      beneficiaryRef: { type: String },
      status: { type: String, enum: ["not_started", "active"], default: "not_started" },
      updatedAt: { type: Date },
    },
    ratingAvg: { type: Number, default: 0 },
    ratingCount: { type: Number, default: 0 },
    submittedAt: { type: Date, default: () => new Date() },
    approvedAt: { type: Date },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    statusChangedAt: { type: Date },
    statusChangedBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true },
);

export type VendorDoc = HydratedDocument<InferSchemaType<typeof vendorSchema>>;
export const Vendor = model("Vendor", vendorSchema);

// What anyone may see on a store page.
export const toPublicStore = (v: VendorDoc, storage: Storage) => ({
  id: v.id as string,
  storeName: v.storeName,
  slug: v.slug,
  description: v.description,
  logoUrl: v.logoKey ? storage.publicUrl(v.logoKey) : null,
  ratingAvg: v.ratingAvg,
  ratingCount: v.ratingCount,
  since: ((v.approvedAt ?? v.createdAt) as Date).toISOString(),
});

// What the vendor sees about their own store.
export const toOwnStore = (v: VendorDoc, storage: Storage) => ({
  ...toPublicStore(v, storage),
  logoKey: v.logoKey ?? null,
  status: v.status as VendorStatus,
  rejectionReason: v.rejectionReason ?? null,
  contactEmail: v.contactEmail,
  phone: v.phone,
  gstin: v.gstin ?? null,
  commissionRateBp: v.commissionRateBp ?? null,
  payout:
    v.payout?.status === "active"
      ? { accountHolder: v.payout.accountHolder ?? "", bankLast4: v.payout.bankLast4 ?? "", ifsc: v.payout.ifsc ?? "", provider: v.payout.provider ?? "mock" }
      : null,
  submittedAt: (v.submittedAt as Date).toISOString(),
  approvedAt: v.approvedAt ? (v.approvedAt as Date).toISOString() : null,
});
