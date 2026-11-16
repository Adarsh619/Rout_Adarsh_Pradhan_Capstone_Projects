import type { Vendor as VendorRow } from "../../generated/prisma/client.js";
import type { Storage } from "../../lib/s3.js";

export const VENDOR_STATUSES = ["pending", "approved", "rejected", "suspended"] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];
export type { VendorRow };

export const toPublicStore = (v: VendorRow, storage: Storage) => ({
  id: v.id,
  storeName: v.storeName,
  slug: v.slug,
  description: v.description,
  logoUrl: v.logoKey ? storage.publicUrl(v.logoKey) : null,
  ratingAvg: v.ratingAvg,
  ratingCount: v.ratingCount,
  since: (v.approvedAt ?? v.createdAt).toISOString(),
});

export const toOwnStore = (v: VendorRow, storage: Storage) => ({
  ...toPublicStore(v, storage),
  logoKey: v.logoKey,
  status: v.status,
  rejectionReason: v.rejectionReason,
  contactEmail: v.contactEmail,
  phone: v.phone,
  gstin: v.gstin,
  commissionRateBp: v.commissionRateBp,
  payout:
    v.payoutStatus === "active"
      ? {
          accountHolder: v.payoutAccountHolder ?? "",
          bankLast4: v.payoutBankLast4 ?? "",
          ifsc: v.payoutIfsc ?? "",
          provider: v.payoutProvider ?? "mock",
        }
      : null,
  submittedAt: v.submittedAt.toISOString(),
  approvedAt: v.approvedAt ? v.approvedAt.toISOString() : null,
});
