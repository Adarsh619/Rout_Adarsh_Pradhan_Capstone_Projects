import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api";

/**
 * Simulated Stripe Checkout / Customer Portal, used only when the server runs with STRIPE_MOCK=true.
 * Confirming sends Stripe-signed webhook events through the real webhook handler on the server.
 */
export default function MockCheckout() {
  const { slug } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const manage = params.get("manage") === "1";
  const [billing, setBilling] = useState(null);
  const [plan, setPlan] = useState(params.get("plan") || "pro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { api.get("/billing/").then(setBilling).catch((e) => setError(e.message)); }, []);

  const submit = (body) => async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.post("/billing/mock/complete/", body);
      navigate(`/w/${slug}/billing?checkout=success`);
    } catch (err) { setError(err.message); setBusy(false); }
  };

  if (!billing) return <p className="muted">{error || "Loading…"}</p>;
  if (billing.mode !== "mock") return <p>Simulated checkout is only available in Stripe mock mode. <Link to={`/w/${slug}/billing`}>Back to billing</Link></p>;
  const p = billing.plans[plan];

  return (
    <div className="checkout">
      <div className="mock-banner">SIMULATED STRIPE CHECKOUT · stripe-mock · no real payment</div>
      <div className="checkout-grid">
        <div className="panel stack">
          <Link to={`/w/${slug}/billing`} className="small">← Back to billing</Link>
          {manage ? (
            <>
              <h2>Manage subscription</h2>
              <p>Current plan: <strong>{billing.plans[billing.plan].name}</strong> ({billing.status})</p>
              <label>Change plan
                <select value={plan} onChange={(e) => setPlan(e.target.value)}>
                  <option value="pro">Pro · $10/month</option>
                  <option value="business">Business · $25/month</option>
                </select>
              </label>
              <button className="primary" disabled={busy || plan === billing.plan} onClick={submit({ action: "subscribe", plan })}>Update plan</button>
              <button className="danger" disabled={busy} onClick={submit({ action: "cancel" })}>Cancel subscription</button>
            </>
          ) : (
            <>
              <div className="muted small">Subscribe to</div>
              <h2>TaskFlow {p.name}</h2>
              <div className="price">${p.price_usd}<span className="muted small"> per month</span></div>
              <ul className="small">{Object.entries(p.limits).map(([k, v]) => <li key={k}>{v ?? "Unlimited"} {k}</li>)}</ul>
            </>
          )}
        </div>
        {!manage && (
          <form className="panel stack" onSubmit={submit({ action: "subscribe", plan })}>
            <h3>Pay with card</h3>
            <label>Email<input value="test@example.com" disabled /></label>
            <label>Card information<input value="4242 4242 4242 4242" disabled /></label>
            <div className="grid-2">
              <label>Expiry<input value="12 / 34" disabled /></label>
              <label>CVC<input value="123" disabled /></label>
            </div>
            <p className="muted small">Test details are pre-filled and nothing is charged. Confirming makes the server send Stripe-signed
              <code> checkout.session.completed</code> and <code>customer.subscription.created</code> events to its webhook.</p>
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy}>{busy ? "Processing…" : `Subscribe · $${p.price_usd}/month`}</button>
          </form>
        )}
        {manage && error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
