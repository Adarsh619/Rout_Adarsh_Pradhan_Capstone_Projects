import { checkoutMessage } from "../billingMessages";

describe("checkoutMessage", () => {
  it("says a mock subscription was simulated, with the new plan", () => {
    expect(checkoutMessage("success", "mock", "Pro")).toBe("Simulated payment complete — you're on Pro. No card was charged.");
  });

  it("waits for Stripe's webhook in live mode", () => {
    expect(checkoutMessage("success", "live", "Pro")).toMatch(/Payment received/);
  });

  it("reports a plan change", () => {
    expect(checkoutMessage("changed", "mock", "Business")).toBe("Plan changed to Business.");
  });

  it("never says payment received after a cancellation", () => {
    const msg = checkoutMessage("canceled", "mock", "Free");
    expect(msg).toBe("Subscription cancelled — you're back on the Free plan.");
    expect(msg).not.toMatch(/Payment/);
  });

  it("shows nothing without a known result", () => {
    expect(checkoutMessage(null, "mock", "Free")).toBeNull();
    expect(checkoutMessage("bogus", "live", "Pro")).toBeNull();
  });
});
