import { config } from "../../config.js";

// Subscription plans and their limits; null means unlimited. Stripe price ids come from the environment.
export type Resource = "projects" | "members" | "issues";
export type PlanId = "free" | "pro" | "business";

export const PLANS: Record<PlanId, { name: string; price_usd: number; limits: Record<Resource, number | null> }> = {
  free: { name: "Free", price_usd: 0, limits: { projects: 2, members: 5, issues: 200 } },
  pro: { name: "Pro", price_usd: 10, limits: { projects: 20, members: 50, issues: 10000 } },
  business: { name: "Business", price_usd: 25, limits: { projects: null, members: null, issues: null } },
};

export const PAID_PLANS = ["pro", "business"] as const;

export const isPlan = (p: string): p is PlanId => p in PLANS;

export function priceId(plan: string): string {
  return plan === "pro" ? config.stripe.pricePro : plan === "business" ? config.stripe.priceBusiness : "";
}

export function planForPrice(price: string | null | undefined): PlanId | null {
  for (const plan of PAID_PLANS) if (price && price === priceId(plan)) return plan;
  return null;
}

// Past-due or canceled workspaces fall back to the free limits.
export const effectivePlan = (sub: { plan: string; status: string }): PlanId =>
  ["active", "trialing"].includes(sub.status) && isPlan(sub.plan) ? sub.plan : "free";
