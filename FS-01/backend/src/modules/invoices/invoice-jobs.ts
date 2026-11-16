import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { logger } from "../../lib/logger.js";
import type { Storage } from "../../lib/s3.js";
import { isUniqueViolation, prisma } from "../../lib/db.js";
import { shippingAddressOf } from "../orders/order.model.js";
import { renderInvoice } from "./invoice-pdf.js";
import { nextInvoiceNumber } from "./invoice.model.js";

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
  const existing = await prisma.invoice.findUnique({ where: { subOrderId } });
  if (existing) return `already ${existing.invoiceNumber}`;
  const part = await prisma.subOrder.findUnique({
    where: { id: subOrderId },
    include: { lines: { orderBy: { position: "asc" } }, order: true, vendor: true },
  });
  if (!part?.placedAt) return "part not paid";
  const { order, vendor } = part;

  const invoiceNumber = await nextInvoiceNumber();
  const a = shippingAddressOf(order);
  const pdf = await renderInvoice({
    invoiceNumber,
    issuedAt: new Date(),
    orderNumber: order.orderNumber,
    paidAt: order.paidAt,
    seller: { name: vendor.storeName, email: vendor.contactEmail, phone: vendor.phone, gstin: vendor.gstin },
    buyer: { name: a.name, phone: a.phone, address: [a.line1, ...(a.line2 ? [a.line2] : []), `${a.city}, ${a.state} ${a.pincode}`] },
    lines: part.lines.map((l) => ({ title: l.title, qty: l.qty, price: l.price })),
    itemsTotal: part.itemsTotal,
    discount: part.discountShare,
    discountLabel: part.discountBy ? DISCOUNT_LABEL[part.discountBy] : null,
    total: part.payable,
    paymentRef: order.paymentProviderPaymentId,
  });
  const s3Key = `invoices/${vendor.id}/${invoiceNumber}.pdf`;
  await storage.put(s3Key, pdf, "application/pdf");
  try {
    await prisma.invoice.create({
      data: { subOrderId: part.id, orderId: order.id, vendorId: vendor.id, customerId: part.customerId, invoiceNumber, s3Key, generatedAt: new Date() },
    });
  } catch (err) {
    // Another run made it at the same moment; keep theirs and drop this file.
    if (isUniqueViolation(err)) {
      await storage.deleteMany([s3Key]);
      return "made by another run";
    }
    throw err;
  }
  await prisma.subOrder.update({ where: { id: part.id }, data: { invoiceNumber } });
  return invoiceNumber;
}
