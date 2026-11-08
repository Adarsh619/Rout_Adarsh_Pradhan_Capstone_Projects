import { describe, expect, it } from "vitest";
import { addDays, fillDays, resolveRange, todayIst } from "../src/modules/analytics/date-range.js";
import { canAdminCancel, canCustomerCancel } from "../src/modules/orders/order-rules.js";

describe("report date ranges (Indian time)", () => {
  it("uses the Indian date, not the server's", () => {
    // 20:00 UTC on 7 Nov is already 8 Nov in India.
    expect(todayIst(new Date("2026-11-07T20:00:00Z"))).toBe("2026-11-08");
    expect(todayIst(new Date("2026-11-07T18:00:00Z"))).toBe("2026-11-07");
  });

  it("defaults to the last 30 days, midnight to midnight IST", () => {
    const r = resolveRange({}, new Date("2026-11-08T06:00:00Z"));
    expect([r.from, r.to, r.days.length]).toEqual(["2026-10-10", "2026-11-08", 30]);
    expect(r.start.toISOString()).toBe("2026-10-09T18:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-11-08T18:30:00.000Z");
  });

  it("refuses backwards or overlong ranges", () => {
    expect(() => resolveRange({ from: "2026-11-08", to: "2026-11-01" })).toThrow(/Some fields/);
    expect(() => resolveRange({ from: "2024-01-01", to: "2026-11-01" })).toThrow(/Some fields/);
    expect(resolveRange({ from: "2026-11-01", to: "2026-11-01" }).days).toEqual(["2026-11-01"]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("fills days without activity with zeros", () => {
    expect(fillDays(["2026-11-01", "2026-11-02", "2026-11-03"], [{ _id: "2026-11-02", sales: 500, orders: 1 }], { sales: 0, orders: 0 })).toEqual([
      { day: "2026-11-01", sales: 0, orders: 0 },
      { day: "2026-11-02", sales: 500, orders: 1 },
      { day: "2026-11-03", sales: 0, orders: 0 },
    ]);
  });
});

describe("who may cancel what", () => {
  it("lets support cancel a shipped part, but nobody a delivered one", () => {
    expect(canCustomerCancel("shipped")).toBe(false);
    expect(canAdminCancel("shipped")).toBe(true);
    expect(canAdminCancel("delivered")).toBe(false);
    expect(canAdminCancel("awaiting_payment")).toBe(false);
  });
});
