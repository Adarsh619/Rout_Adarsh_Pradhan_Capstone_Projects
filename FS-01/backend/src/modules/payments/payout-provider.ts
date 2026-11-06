import { createHash } from "node:crypto";

// Pays vendors their share. Razorpay's payout product (RazorpayX) and Route both need a registered business, so v1
// uses a simulated provider: every step (beneficiary, payout, reference) happens and is recorded, but no bank is
// called. It's labelled "simulated" everywhere a vendor sees it. A real provider would plug in here unchanged.
export interface PayoutProvider {
  readonly name: "mock";
  // Registers the bank account once; only the provider keeps the full account number.
  registerBeneficiary(input: { vendorId: string; accountHolder: string; accountNumber: string; ifsc: string }): Promise<{ beneficiaryRef: string }>;
  // Sends money. `key` makes retries safe: the same key always returns the same payout.
  pay(input: { beneficiaryRef: string; amount: number; key: string }): Promise<{ providerRef: string; status: "processed" }>;
}

const shortHash = (data: string) => createHash("sha256").update(data).digest("base64url").slice(0, 14);

export class MockPayoutProvider implements PayoutProvider {
  readonly name = "mock" as const;

  async registerBeneficiary(input: { vendorId: string; accountNumber: string; ifsc: string }) {
    return { beneficiaryRef: `bene_mock_${shortHash(`${input.vendorId}|${input.ifsc}|${input.accountNumber}`)}` };
  }

  async pay(input: { beneficiaryRef: string; amount: number; key: string }) {
    return { providerRef: `pout_mock_${shortHash(input.key)}`, status: "processed" as const };
  }
}
