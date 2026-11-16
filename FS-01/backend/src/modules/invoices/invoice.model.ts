import { nextSeq } from "../../lib/db.js";

// One invoice per store's part of a paid order (the `invoices` table). The PDF itself is a private file in S3; the
// API hands out short-lived download links to the buyer, the seller and admins only.

export const formatInvoiceNumber = (year: number, seq: number) => `INV-${year}-${String(seq).padStart(6, "0")}`;

export async function nextInvoiceNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  return formatInvoiceNumber(year, await nextSeq(`invoice-${year}`));
}
