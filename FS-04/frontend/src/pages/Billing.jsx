import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { checkoutMessage } from "../billingMessages";
import { useWorkspace } from "../workspace";

export default function Billing() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [params] = useSearchParams();
  const { reloadWorkspace } = useWorkspace();
  useEffect(() => {
    api.get("/billing/").then(setData).catch((e) => setError(e.message));
    reloadWorkspace(); // keep the sidebar's plan badge in sync after checkout
  }, [reloadWorkspace]);

  const navigate = useNavigate();
  const go = (path, body) => async () => {
    setError("");
    try {
      const r = await api.post(path, body);
      if (r.url.startsWith("/")) navigate(r.url); // mock mode: simulated checkout inside the app
      else window.location.href = r.url;          // real Stripe: hosted checkout / portal
    } catch (e) { setError(e.message); }
  };
  if (!data) return <p className="muted">{error || "Loading…"}</p>;
  const message = checkoutMessage(params.get("checkout"), data.mode, data.plans[data.plan].name);

  return (
    <div className="stack">
      <h2>Billing</h2>
      {message && <div className="toast static">{message}</div>}
      {data.mode === "mock" && (
        <div className="toast static">
          <strong>Stripe mock mode.</strong> Stripe API calls go to Stripe's official <code>stripe-mock</code> server and the checkout page is simulated.
          No Stripe account, no card, no charges. Switch to real Stripe test keys anytime in <code>.env</code>.
        </div>
      )}
      {!data.stripe_enabled && <div className="error">Stripe is not configured on the server (set STRIPE_MOCK=true, or real test keys, in .env).</div>}
      {error && <div className="error">{error}</div>}
      <div className="panel">
        <div className="row between">
          <div>Current plan: <strong>{data.plans[data.plan].name}</strong> <span className="badge">{data.status}</span>
            {data.current_period_end && <span className="muted small"> · renews {new Date(data.current_period_end).toLocaleDateString()}</span>}
            {data.cancel_at_period_end && <span className="muted small"> · cancels at period end</span>}
          </div>
          {data.can_manage && data.has_subscription && <button onClick={go("/billing/portal/")}>Manage subscription</button>}
        </div>
        <div className="stats">
          {Object.entries(data.usage).map(([k, v]) => {
            const limit = data.limits[k];
            const pct = limit ? Math.min(100, (v / limit) * 100) : 0;
            return (
              <div key={k} className="stat">
                <div className="stat-value">{v}<span className="muted small"> / {limit ?? "∞"}</span></div>
                <div className="muted small">{k}</div>
                <div className="meter"><div style={{ width: `${pct}%` }} className={pct >= 90 ? "hot" : ""} /></div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="grid-cards">
        {Object.entries(data.plans).map(([key, p]) => (
          <div key={key} className={`panel plan ${key === data.plan ? "current" : ""}`}>
            <h3>{p.name}</h3>
            <div className="price">${p.price_usd}<span className="muted small">/month</span></div>
            <ul className="small">
              {Object.entries(p.limits).map(([k, v]) => <li key={k}>{v ?? "Unlimited"} {k}</li>)}
            </ul>
            {key === data.plan ? <span className="badge">Current plan</span>
              : key !== "free" && data.can_manage && (data.has_subscription
                // Already subscribed: change the existing subscription, never start a second one (double billing).
                ? <button onClick={go("/billing/portal/")}>Switch plan</button>
                : <button className="primary" onClick={go("/billing/checkout/", { plan: key })}>Upgrade</button>)}
          </div>
        ))}
      </div>
      {!data.can_manage && <p className="muted small">Only the workspace owner can change the plan.</p>}
      {data.mode === "live" && <p className="muted small">Test mode: pay with card 4242 4242 4242 4242, any future date, any CVC.</p>}
    </div>
  );
}
