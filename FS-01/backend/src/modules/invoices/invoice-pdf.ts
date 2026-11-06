import PDFDocument from "pdfkit";

export interface InvoiceData {
  invoiceNumber: string;
  issuedAt: Date;
  orderNumber: string;
  paidAt: Date | null;
  seller: { name: string; email: string; phone: string; gstin: string | null };
  buyer: { name: string; phone: string; address: string[] };
  lines: { title: string; qty: number; price: number }[];
  itemsTotal: number;
  discount: number;
  discountLabel: string | null;
  total: number;
  paymentRef: string | null;
}

// The built-in PDF fonts have no ₹ sign, so amounts read "Rs. 1,999.00".
export const rs = (paise: number) => `Rs. ${(paise / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (d: Date) => d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

// One store's part of an order as an A4 PDF. Uses only the PDF standard fonts, so nothing has to be bundled.
export function renderInvoice(data: InvoiceData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50, compress: opts.compress ?? true, info: { Title: `Invoice ${data.invoiceNumber}`, Author: "ShopSphere" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = 50;
    const right = 545;
    const width = right - left;

    // Header
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#4f46e5").text("ShopSphere", left, 50);
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text("Multi-vendor marketplace", left, 74);
    doc.font("Helvetica-Bold").fontSize(16).fillColor("#0f172a").text("INVOICE", left, 50, { width, align: "right" });
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    doc.text(`Invoice no. ${data.invoiceNumber}`, left, 72, { width, align: "right" });
    doc.text(`Date ${date(data.issuedAt)}`, { width, align: "right" });
    doc.text(`Order ${data.orderNumber}`, { width, align: "right" });

    // Seller and buyer
    const top = 125;
    const col = width / 2;
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Sold by", left, top);
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    doc.text(data.seller.name, left, top + 15, { width: col - 10 });
    doc.text(data.seller.email, { width: col - 10 });
    doc.text(`Phone ${data.seller.phone}`, { width: col - 10 });
    if (data.seller.gstin) doc.text(`GSTIN ${data.seller.gstin}`, { width: col - 10 });

    doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a").text("Ship to", left + col, top);
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    doc.text(data.buyer.name, left + col, top + 15, { width: col });
    for (const line of data.buyer.address) doc.text(line, { width: col });
    doc.text(`Phone ${data.buyer.phone}`, { width: col });

    // Lines
    let y = 230;
    const cols = { item: left, qty: left + 300, price: left + 350, amount: left + 420 };
    const header = (at: number) => {
      doc.rect(left, at - 5, width, 20).fill("#eef2ff");
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a");
      doc.text("Item", cols.item + 5, at, { width: 290 });
      doc.text("Qty", cols.qty, at, { width: 40, align: "right" });
      doc.text("Price", cols.price, at, { width: 65, align: "right" });
      doc.text("Amount", cols.amount, at, { width: width - 420 - 5, align: "right" });
    };
    header(y);
    y += 25;
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    for (const line of data.lines) {
      const h = doc.heightOfString(line.title, { width: 290 });
      if (y + h > 740) {
        doc.addPage();
        y = 60;
        header(y);
        y += 25;
        doc.font("Helvetica").fontSize(9).fillColor("#334155");
      }
      doc.text(line.title, cols.item + 5, y, { width: 290 });
      doc.text(String(line.qty), cols.qty, y, { width: 40, align: "right" });
      doc.text(rs(line.price), cols.price, y, { width: 65, align: "right" });
      doc.text(rs(line.price * line.qty), cols.amount, y, { width: width - 420 - 5, align: "right" });
      y += Math.max(h, 12) + 8;
      doc.moveTo(left, y - 4).lineTo(right, y - 4).strokeColor("#e2e8f0").lineWidth(0.5).stroke();
    }

    // Totals
    y += 6;
    const total = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor("#0f172a");
      doc.text(label, cols.price - 120, y, { width: 185, align: "right" });
      doc.text(value, cols.amount, y, { width: width - 420 - 5, align: "right" });
      y += bold ? 18 : 14;
    };
    total("Items", rs(data.itemsTotal));
    if (data.discount > 0) total(data.discountLabel ?? "Discount", `- ${rs(data.discount)}`);
    total("Delivery", "Free");
    total("Total paid", rs(data.total), true);

    y += 20;
    doc.font("Helvetica").fontSize(9).fillColor("#334155");
    if (data.paidAt) doc.text(`Paid on ${date(data.paidAt)}${data.paymentRef ? ` (payment ${data.paymentRef})` : ""}. Prices include all taxes.`, left, y, { width });
    doc.moveDown(2);
    doc.fontSize(8).fillColor("#94a3b8").text("ShopSphere is a student project running in test mode: no real money was charged and this is not a tax invoice.", { width });

    doc.end();
  });
}
