import { describe, expect, it } from "vitest";
import { allocate, applyCoupon, couponProblem, discountOn, type CouponTerms } from "../src/modules/coupons/coupon-rules.js";
import { renderInvoice, rs } from "../src/modules/invoices/invoice-pdf.js";
import { formatInvoiceNumber } from "../src/modules/invoices/invoice.model.js";
import { splitByVendor, type PricedLine } from "../src/modules/orders/order-rules.js";

const line = (vendorId: string, price: number, qty = 1, commissionRateBp = 1000): PricedLine => ({ productId: `p-${vendorId}-${price}`, vendorId, title: "Thing", price, qty, commissionRateBp });

// Vikram: ₹20,000 phone at 10%; Meera: two ₹299 cables at 10%.
const parts = () => splitByVendor([line("vikram", 2_000_000), line("meera", 29_900, 2)]);

const platform = (overrides: Partial<CouponTerms> = {}): CouponTerms => ({ scope: "platform", type: "percent", value: 1000, maxDiscount: 20_000, minOrder: 49_900, ...overrides });
const vendor = (overrides: Partial<CouponTerms> = {}): CouponTerms => ({ scope: "vendor", vendorId: "vikram", type: "percent", value: 500, minOrder: 100_000, ...overrides });

// What the customer pays plus what the platform covers equals what vendors and the platform are owed: the ledger rule.
function balances(result: ReturnType<typeof applyCoupon>) {
  const payable = result.parts.reduce((n, p) => n + p.payable, 0);
  const owed = result.parts.reduce((n, p) => n + p.vendorNet + p.commission, 0);
  return payable + result.platformDiscount === owed;
}

describe("discount amounts", () => {
  it("takes a percentage rounded to the paisa, capped, and never more than the amount", () => {
    expect(discountOn({ type: "percent", value: 1000, maxDiscount: null }, 49_950)).toBe(4_995);
    expect(discountOn({ type: "percent", value: 1000, maxDiscount: 20_000 }, 2_059_800)).toBe(20_000);
    expect(discountOn({ type: "flat", value: 10_000 }, 5_000)).toBe(5_000);
  });

  it("splits an amount in proportion and gives leftover paise to the largest part", () => {
    expect(allocate(20_000, [2_000_000, 59_800])).toEqual([19_420, 580]);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(0, [5, 5])).toEqual([0, 0]);
    for (const [amount, weights] of [[9_999, [3, 7, 11]], [1, [100, 200]]] as const) {
      expect(allocate(amount, [...weights]).reduce((a, b) => a + b, 0)).toBe(amount);
    }
  });
});

describe("applying a coupon", () => {
  it("platform coupon: split by value, vendors keep their full share, the platform pays", () => {
    const r = applyCoupon(parts(), platform());
    expect(r).toMatchObject({ discount: 20_000, platformDiscount: 20_000 });
    expect(r.parts.map((p) => [p.discountShare, p.payable, p.commission, p.vendorNet, p.discountBy])).toEqual([
      [19_420, 1_980_580, 200_000, 1_800_000, "platform"],
      [580, 59_220, 5_980, 53_820, "platform"],
    ]);
    expect(balances(r)).toBe(true);
  });

  it("platform coupon: never gives away more than the platform's commission", () => {
    const r = applyCoupon(parts(), platform({ value: 5000, maxDiscount: null }));
    expect(r.discount).toBe(205_980);
    expect(balances(r)).toBe(true);
  });

  it("vendor coupon: only that store's part, and the store's commission is on what was paid", () => {
    const r = applyCoupon(parts(), vendor());
    expect(r).toMatchObject({ discount: 100_000, platformDiscount: 0 });
    expect(r.parts[0]).toMatchObject({ discountShare: 100_000, payable: 1_900_000, commission: 190_000, vendorNet: 1_710_000, discountBy: "vendor" });
    expect(r.parts[1]).toMatchObject({ discountShare: 0, payable: 59_800, commission: 5_980, vendorNet: 53_820, discountBy: null });
    expect(balances(r)).toBe(true);
  });

  it("no coupon changes nothing", () => {
    const r = applyCoupon(parts(), null);
    expect(r.discount).toBe(0);
    expect(r.parts.every((p) => p.payable === p.itemsTotal)).toBe(true);
  });
});

describe("when a coupon can be used", () => {
  const now = new Date("2026-11-07T10:00:00Z");
  const state = { isActive: true, usedCount: 0, perUserLimit: 1, usageLimit: null as number | null, startsAt: null as Date | null, endsAt: null as Date | null };
  const cartParts = [
    { vendorId: "vikram", itemsTotal: 80_000 },
    { vendorId: "meera", itemsTotal: 59_800 },
  ];
  const check = (overrides: Partial<typeof state & CouponTerms> = {}, usedByThisCustomer = 0, p = cartParts) =>
    couponProblem({ ...state, ...platform(), ...overrides }, { now, usedByThisCustomer, parts: p });

  it("explains every reason it can't", () => {
    expect(check()).toBeNull();
    expect(check({ isActive: false })).toMatch(/no longer active/);
    expect(check({ startsAt: new Date("2026-12-01") })).toMatch(/isn't valid yet/);
    expect(check({ endsAt: new Date("2026-11-01") })).toMatch(/expired/);
    expect(check({ usageLimit: 5, usedCount: 5 })).toMatch(/fully used/);
    expect(check({}, 1)).toMatch(/already used/);
    expect(check({ minOrder: 200_000 })).toBe("Add items worth ₹602 more to use this coupon.");
    expect(couponProblem({ ...state, ...vendor() }, { now, usedByThisCustomer: 0, parts: cartParts })).toBe("Add items worth ₹200 more to use this coupon (from this store).");
    expect(couponProblem({ ...state, ...vendor({ vendorId: "arjun" }) }, { now, usedByThisCustomer: 0, parts: cartParts })).toMatch(/nothing in your cart/);
  });
});

describe("invoice PDF", () => {
  it("renders a PDF with the invoice details", async () => {
    const pdf = await renderInvoice(
      {
        invoiceNumber: formatInvoiceNumber(2026, 42),
        issuedAt: new Date("2026-11-07T10:00:00Z"),
        orderNumber: "SS-2026-000001",
        paidAt: new Date("2026-11-07T09:59:00Z"),
        seller: { name: "Vikram Electronics", email: "store@example.com", phone: "9876543210", gstin: "29ABCDE1234F1Z5" },
        buyer: { name: "Priya Sharma", phone: "9876543210", address: ["12 MG Road", "Bengaluru, Karnataka 560001"] },
        lines: Array.from({ length: 40 }, (_, i) => ({ title: `Product number ${i + 1} with a fairly long name`, qty: 1, price: 99_900 })),
        itemsTotal: 3_996_000,
        discount: 20_000,
        discountLabel: "Coupon (paid by ShopSphere)",
        total: 3_976_000,
        paymentRef: "pay_123",
      },
      { compress: false },
    );
    const text = pdf.toString("latin1");
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toContain("INV-2026-000042");
    // 40 lines don't fit on one page.
    expect((text.match(/\/Type \/Page\b/g) ?? []).length).toBe(2);
    expect(rs(199_950)).toBe("Rs. 1,999.50");
  });
});
