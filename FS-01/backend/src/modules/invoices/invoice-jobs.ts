import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "../../lib/logger.js";
import type { Storage } from "../../lib/s3.js";
import { Order, SubOrder } from "../orders/order.model.js";
import { Vendor } from "../vendors/vendor.model.js";
import { renderInvoice } from "./invoice-pdf.js";
import { Invoice, nextInvoiceNumber } from "./invoice.model.js";

export const INVOICE_QUEUE = "invoice-pdf";

// Invoice PDFs are made in the background once an order is paid: rendering and uploading a PDF takes a moment, and
// the payment request shouldn't wait for it (or fail if S3 is briefly unreachable).
export interface InvoiceJobs {
  generate(subOrderId: string): Promise<void>;
}

export function queuedInvoiceJobs(connection: Redis): InvoiceJobs & { queue: Queue } {
  const queue = new Queue<{ subOrderId: string }>(INVOICE_QUEUE, { connection });
  return {
    queue,
    async generate(subOrderId) {
      try {
        await queue.add(
          "generate",
          { subOrderId },
          { jobId: `invoice-${subOrderId}`, attempts: 8, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 7 * 24 * 3600 } },
        );
      } catch (err) {
        logger.error({ err, subOrderId }, "could not queue an invoice");
      }
    },
  };
}

export function directInvoiceJobs(storage: Storage): InvoiceJobs {
  return {
    async generate(subOrderId) {
      try {
        await generateInvoice(storage, subOrderId);
      } catch (err) {
        logger.warn({ err, subOrderId }, "invoice failed");
      }
    },
  };
}

export const noInvoiceJobs: InvoiceJobs = { generate: async () => {} };

const DISCOUNT_LABEL = { platform: "Coupon (paid by ShopSphere)", vendor: "Store coupon" } as const;

// Makes the part's invoice once: a second run finds it and does nothing.
export async function generateInvoice(storage: Storage, subOrderId: string): Promise<string> {
  const existing = await Invoice.findOne({ subOrderId });
  if (existing) return `already ${existing.invoiceNumber}`;
  const part = await SubOrder.findById(subOrderId);
  if (!part?.placedAt) return "part not paid";
  const [order, vendor] = await Promise.all([Order.findById(part.orderId), Vendor.findById(part.vendorId)]);
  if (!order || !vendor) return "order or store missing";

  const invoiceNumber = await nextInvoiceNumber();
  const a = order.shippingAddress;
  const pdf = await renderInvoice({
    invoiceNumber,
    issuedAt: new Date(),
    orderNumber: order.orderNumber,
    paidAt: order.payment?.paidAt ?? null,
    seller: { name: vendor.storeName, email: vendor.contactEmail, phone: vendor.phone, gstin: vendor.gstin ?? null },
    buyer: { name: a.name, phone: a.phone, address: [a.line1, ...(a.line2 ? [a.line2] : []), `${a.city}, ${a.state} ${a.pincode}`] },
    lines: part.items.map((l) => ({ title: l.title, qty: l.qty, price: l.price })),
    itemsTotal: part.itemsTotal,
    discount: part.discountShare ?? 0,
    discountLabel: part.discountBy ? DISCOUNT_LABEL[part.discountBy as "platform" | "vendor"] : null,
    total: part.payable,
    paymentRef: order.payment?.providerPaymentId ?? null,
  });
  const s3Key = `invoices/${vendor.id as string}/${invoiceNumber}.pdf`;
  await storage.put(s3Key, pdf, "application/pdf");
  try {
    await Invoice.create({ subOrderId: part._id, orderId: order._id, vendorId: vendor._id, customerId: part.customerId, invoiceNumber, s3Key, generatedAt: new Date() });
  } catch (err) {
    // Another run made it at the same moment; keep theirs and drop this file.
    if ((err as { code?: number }).code === 11000) {
      await storage.deleteMany([s3Key]);
      return "made by another run";
    }
    throw err;
  }
  await SubOrder.updateOne({ _id: part._id }, { $set: { invoiceNumber } });
  return invoiceNumber;
}
