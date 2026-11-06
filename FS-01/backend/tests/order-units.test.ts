import { describe, expect, it } from "vitest";
import { MAX_LINE_QTY } from "../src/modules/cart/cart-store.js";
import { formatOrderNumber } from "../src/modules/orders/order.model.js";
import {
  canCustomerCancel,
  canVendorMove,
  commissionOf,
  commissionRate,
  PLATFORM_COMMISSION_BP,
  rollUpOrderStatus,
  splitByVendor,
  type PricedLine,
} from "../src/modules/orders/order-rules.js";
import { createPaymentProvider, MockPaymentProvider } from "../src/modules/payments/payment-provider.js";

const line = (vendorId: string, price: number, qty: number, commissionRateBp = 1000): PricedLine => ({
  productId: `p-${vendorId}-${price}`,
  vendorId,
  title: "Thing",
  price,
  qty,
  commissionRateBp,
});

describe("commission", () => {
  it("takes the vendor's rate, then the category's, then the department's, then the platform default", () => {
    expect(commissionRate(800, 1500, 500)).toBe(800);
    expect(commissionRate(null, 1500, 500)).toBe(1500);
    expect(commissionRate(null, null, 500)).toBe(500);
    expect(commissionRate(undefined, null, undefined)).toBe(PLATFORM_COMMISSION_BP);
    // 0% is a real rate, not "unset".
    expect(commissionRate(0, 1500, 500)).toBe(0);
  });

  it("rounds to the nearest paisa", () => {
    expect(commissionOf(49_900, 1500)).toBe(7_485);
    expect(commissionOf(99_999, 1000)).toBe(10_000);
    expect(commissionOf(33, 1500)).toBe(5);
  });
});

describe("splitByVendor", () => {
  it("makes one part per store, in the order stores first appear, and the money always adds up", () => {
    const parts = splitByVendor([line("a", 2_000_000, 1, 1500), line("b", 29_900, 2, 500), line("a", 49_900, 2, 1500)]);
    expect(parts.map((p) => p.vendorId)).toEqual(["a", "b"]);
    expect(parts[0]).toMatchObject({ itemsTotal: 2_099_800, commission: 314_970, vendorNet: 1_784_830 });
    expect(parts[1]).toMatchObject({ itemsTotal: 59_800, commission: 2_990, vendorNet: 56_810 });
    for (const p of parts) expect(p.commission + p.vendorNet).toBe(p.itemsTotal);
  });
});

describe("status rules", () => {
  it("lets a vendor move a paid part one step at a time and never back", () => {
    expect(canVendorMove("placed", "packed")).toBe(true);
    expect(canVendorMove("packed", "shipped")).toBe(true);
    expect(canVendorMove("shipped", "delivered")).toBe(true);
    expect(canVendorMove("placed", "delivered")).toBe(false);
    expect(canVendorMove("shipped", "packed")).toBe(false);
    expect(canVendorMove("awaiting_payment", "packed")).toBe(false);
    expect(canVendorMove("cancelled", "packed")).toBe(false);
  });

  it("lets the customer cancel only before the part ships", () => {
    expect(["placed", "packed"].every((s) => canCustomerCancel(s as never))).toBe(true);
    expect(["awaiting_payment", "shipped", "delivered", "cancelled"].some((s) => canCustomerCancel(s as never))).toBe(false);
  });

  it("completes an order when every part is delivered or cancelled", () => {
    expect(rollUpOrderStatus(["delivered", "placed"])).toBe("confirmed");
    expect(rollUpOrderStatus(["delivered", "cancelled"])).toBe("completed");
    expect(rollUpOrderStatus(["cancelled", "cancelled"])).toBe("cancelled");
  });
});

describe("order numbers and limits", () => {
  it("formats order numbers per year", () => {
    expect(formatOrderNumber(2026, 123)).toBe("SS-2026-000123");
  });
  it("caps a cart line", () => {
    expect(MAX_LINE_QTY).toBe(10);
  });
});

describe("mock payments", () => {
  const provider = createPaymentProvider("mock", "unit-test-secret") as MockPaymentProvider;

  it("signs like Razorpay and accepts only an untampered proof", async () => {
    const { providerOrderId } = await provider.createOrder();
    const paid = provider.pay(providerOrderId);
    expect(provider.verifyPayment({ providerOrderId, ...paid })).toBe(true);
    expect(provider.verifyPayment({ providerOrderId, providerPaymentId: "pay_mock_other", signature: paid.signature })).toBe(false);
    expect(provider.verifyPayment({ providerOrderId: "order_mock_other", ...paid })).toBe(false);
    expect(provider.verifyPayment({ providerOrderId, providerPaymentId: paid.providerPaymentId, signature: "short" })).toBe(false);
  });

  it("uses a different key per server secret", async () => {
    const other = createPaymentProvider("mock", "another-secret") as MockPaymentProvider;
    const { providerOrderId } = await provider.createOrder();
    expect(other.verifyPayment({ providerOrderId, ...provider.pay(providerOrderId) })).toBe(false);
  });

});
