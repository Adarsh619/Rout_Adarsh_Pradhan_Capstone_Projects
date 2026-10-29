// Message shown on the billing page after returning from checkout or the subscription manager.
// `result` comes from ?checkout= (success | changed | canceled); `mode` is "mock" or "live";
// `planName` is the plan the server now reports.
export function checkoutMessage(result, mode, planName) {
  switch (result) {
    case "success":
      return mode === "mock"
        ? `Simulated payment complete — you're on ${planName}. No card was charged.`
        : "Payment received — your plan updates as soon as Stripe sends the webhook.";
    case "changed":
      return `Plan changed to ${planName}.`;
    case "canceled":
      return "Subscription cancelled — you're back on the Free plan.";
    default:
      return null;
  }
}
