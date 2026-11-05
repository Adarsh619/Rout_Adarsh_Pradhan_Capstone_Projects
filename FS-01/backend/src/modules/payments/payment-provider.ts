import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Takes the customer's money. The order code only talks to this interface: `mock` works offline with no account
// (local development, tests and CI), `razorpay` (Day 6) uses real Razorpay test mode.
export interface PaymentProvider {
  readonly name: "mock" | "razorpay";
  // Creates the provider-side order the payment popup is opened for. Amount in paise.
  createOrder(input: { amount: number; receipt: string }): Promise<{ providerOrderId: string }>;
  // The popup returns a payment id and a signature; only a correct signature proves the payment happened.
  verifyPayment(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean;
  // Public settings the browser needs to open the popup (Razorpay's key id); never secrets.
  publicConfig(): Record<string, string>;
}

const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");

export function signaturesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Stands in for Razorpay and behaves the same way: the signature is HMAC-SHA256 of "<order id>|<payment id>"
// with a server-side secret, exactly Razorpay's scheme. The "popup" is the mock gateway endpoint, which signs a
// payment for an order only after the customer presses Pay on the test payment screen.
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;
  constructor(private readonly secret: string) {}

  async createOrder(): Promise<{ providerOrderId: string }> {
    return { providerOrderId: `order_mock_${randomBytes(9).toString("base64url")}` };
  }

  // What the mock gateway hands back after a successful test payment.
  pay(providerOrderId: string): { providerPaymentId: string; signature: string } {
    const providerPaymentId = `pay_mock_${randomBytes(9).toString("base64url")}`;
    return { providerPaymentId, signature: hmacHex(this.secret, `${providerOrderId}|${providerPaymentId}`) };
  }

  verifyPayment(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean {
    return signaturesMatch(hmacHex(this.secret, `${input.providerOrderId}|${input.providerPaymentId}`), input.signature);
  }

  publicConfig(): Record<string, string> {
    return {};
  }
}

export function createPaymentProvider(provider: "mock" | "razorpay", serverSecret: string): PaymentProvider {
  if (provider === "razorpay") {
    throw new Error("PAYMENT_PROVIDER=razorpay arrives on Day 6; use PAYMENT_PROVIDER=mock until then");
  }
  // Its own key, derived from the server secret, so a mock payment signature can't be confused with a token.
  return new MockPaymentProvider(hmacHex(serverSecret, "shopsphere-mock-payments"));
}
