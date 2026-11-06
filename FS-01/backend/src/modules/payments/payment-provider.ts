import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../../middleware/errors.js";

// Takes the customer's money. The order code only talks to this interface: `mock` works offline with no account
// (local development, tests and CI), `razorpay` uses real Razorpay test mode.
export interface PaymentProvider {
  readonly name: "mock" | "razorpay";
  // Creates the provider-side order the payment popup is opened for. Amount in paise.
  createOrder(input: { amount: number; receipt: string }): Promise<{ providerOrderId: string }>;
  // The popup returns a payment id and a signature; only a correct signature proves the payment happened.
  verifyPayment(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean;
  // Makes sure the money is actually taken (captured) for this order and amount, not just authorised.
  ensureCaptured(input: { providerOrderId: string; providerPaymentId: string; amount: number }): Promise<void>;
  // Refunds part or all of a payment. `key` makes it safe to retry: the same key never refunds twice.
  refund(input: { providerPaymentId: string; amount: number; key: string }): Promise<{ refundId: string; status: "processed" | "pending" }>;
  // Public settings the browser needs to open the popup (Razorpay's key id); never secrets.
  publicConfig(): Record<string, string>;
}

const hmacHex = (secret: string, data: string) => createHmac("sha256", secret).update(data).digest("hex");
const shortHash = (data: string) => createHash("sha256").update(data).digest("base64url").slice(0, 14);

export function signaturesMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Razorpay's webhook signature: HMAC-SHA256 of the raw request body with the webhook secret.
export const webhookSignatureValid = (secret: string, rawBody: Buffer, signature: string) => signaturesMatch(hmacHex(secret, rawBody.toString("utf8")), signature);

// The payment signature, for both drivers: HMAC-SHA256 of "<order id>|<payment id>".
const paymentSignature = (secret: string, orderId: string, paymentId: string) => hmacHex(secret, `${orderId}|${paymentId}`);

// Stands in for Razorpay and behaves the same way. The "popup" is the mock gateway endpoint, which signs a payment
// for an order only after the customer presses Pay on the test payment screen.
export class MockPaymentProvider implements PaymentProvider {
  readonly name = "mock" as const;
  constructor(private readonly secret: string) {}

  async createOrder(): Promise<{ providerOrderId: string }> {
    return { providerOrderId: `order_mock_${randomBytes(9).toString("base64url")}` };
  }

  // What the mock gateway hands back after a successful test payment.
  pay(providerOrderId: string): { providerPaymentId: string; signature: string } {
    const providerPaymentId = `pay_mock_${randomBytes(9).toString("base64url")}`;
    return { providerPaymentId, signature: paymentSignature(this.secret, providerOrderId, providerPaymentId) };
  }

  verifyPayment(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean {
    return signaturesMatch(paymentSignature(this.secret, input.providerOrderId, input.providerPaymentId), input.signature);
  }

  async ensureCaptured(): Promise<void> {}

  async refund(input: { providerPaymentId: string; amount: number; key: string }): Promise<{ refundId: string; status: "processed" | "pending" }> {
    return { refundId: `rfnd_mock_${shortHash(input.key)}`, status: "processed" };
  }

  publicConfig(): Record<string, string> {
    return {};
  }
}

export class PaymentProviderError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}

type RazorpayPayment = { id: string; order_id: string; amount: number; status: string };
type RazorpayRefund = { id: string; status: string; notes?: Record<string, string> | unknown[] };

// Razorpay's REST API (https://razorpay.com/docs/api/), called directly with the key id and secret.
// Only test keys are accepted (checked when the settings are loaded), so no real money can move.
export class RazorpayPaymentProvider implements PaymentProvider {
  readonly name = "razorpay" as const;
  private readonly auth: string;

  constructor(
    private readonly keyId: string,
    private readonly keySecret: string,
    private readonly http: typeof fetch = fetch,
    private readonly baseUrl = "https://api.razorpay.com/v1",
  ) {
    this.auth = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.auth, ...(body !== undefined && { "Content-Type": "application/json" }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string; code?: string } };
    if (!res.ok) throw new PaymentProviderError(json.error?.description ?? `Razorpay answered ${res.status}`, res.status, json.error?.code);
    return json;
  }

  async createOrder(input: { amount: number; receipt: string }) {
    const order = await this.call<{ id: string }>("POST", "/orders", {
      amount: input.amount,
      currency: "INR",
      receipt: input.receipt,
      notes: { orderNumber: input.receipt },
    });
    return { providerOrderId: order.id };
  }

  verifyPayment(input: { providerOrderId: string; providerPaymentId: string; signature: string }): boolean {
    return signaturesMatch(paymentSignature(this.keySecret, input.providerOrderId, input.providerPaymentId), input.signature);
  }

  async ensureCaptured(input: { providerOrderId: string; providerPaymentId: string; amount: number }): Promise<void> {
    const payment = await this.call<RazorpayPayment>("GET", `/payments/${encodeURIComponent(input.providerPaymentId)}`);
    if (payment.order_id !== input.providerOrderId || payment.amount !== input.amount) {
      throw new AppError(400, "invalid_signature", "This payment doesn't belong to this order.");
    }
    if (payment.status === "captured") return;
    if (payment.status === "authorized") {
      await this.call("POST", `/payments/${encodeURIComponent(payment.id)}/capture`, { amount: input.amount, currency: "INR" });
      return;
    }
    throw new AppError(409, "payment_not_completed", "The payment didn't go through. Nothing was charged; you can try again.");
  }

  async refund(input: { providerPaymentId: string; amount: number; key: string }) {
    const path = `/payments/${encodeURIComponent(input.providerPaymentId)}/refunds`;
    // A retry after a crash must not refund twice: look for a refund already made with this key first.
    const existing = await this.call<{ items: RazorpayRefund[] }>("GET", `${path}?count=100`);
    const found = existing.items.find((r) => !Array.isArray(r.notes) && r.notes?.key === input.key);
    const refund = found ?? (await this.call<RazorpayRefund>("POST", `/payments/${encodeURIComponent(input.providerPaymentId)}/refund`, {
      amount: input.amount,
      speed: "normal",
      notes: { key: input.key },
    }));
    return { refundId: refund.id, status: refund.status === "processed" ? ("processed" as const) : ("pending" as const) };
  }

  publicConfig(): Record<string, string> {
    return { keyId: this.keyId };
  }
}

export function createPaymentProvider(
  provider: "mock" | "razorpay",
  serverSecret: string,
  razorpay?: { keyId?: string; keySecret?: string },
): PaymentProvider {
  if (provider === "razorpay") {
    if (!razorpay?.keyId || !razorpay.keySecret) throw new Error("PAYMENT_PROVIDER=razorpay needs RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET");
    return new RazorpayPaymentProvider(razorpay.keyId, razorpay.keySecret);
  }
  // Its own key, derived from the server secret, so a mock payment signature can't be confused with a token.
  return new MockPaymentProvider(hmacHex(serverSecret, "shopsphere-mock-payments"));
}
