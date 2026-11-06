import { model, Schema } from "mongoose";
import { Counter } from "../orders/order.model.js";

// One invoice per store's part of a paid order. The PDF itself is a private file in S3; the API hands out
// short-lived download links to the buyer, the seller and admins only.
const invoiceSchema = new Schema(
  {
    subOrderId: { type: Schema.Types.ObjectId, ref: "SubOrder", required: true, unique: true },
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true },
    vendorId: { type: Schema.Types.ObjectId, ref: "Vendor", required: true },
    customerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    invoiceNumber: { type: String, required: true, unique: true },
    s3Key: { type: String, required: true },
    generatedAt: { type: Date, required: true },
  },
  { timestamps: false },
);

export const Invoice = model("Invoice", invoiceSchema);

export const formatInvoiceNumber = (year: number, seq: number) => `INV-${year}-${String(seq).padStart(6, "0")}`;

export async function nextInvoiceNumber(now = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const counter = await Counter.findOneAndUpdate({ _id: `invoice-${year}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: "after" });
  return formatInvoiceNumber(year, counter.seq);
}
