import { useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";

// The demo password is only useful where the demo data was seeded; hide it with VITE_DEMO_HINT=false.
const SHOW_DEMO_HINT = import.meta.env.VITE_DEMO_HINT !== "false";

export default function Login() {
  const { user, login, sessionExpired } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Back to the page that sent you here (e.g. a shared board link), or the workspace list.
  const from = location.state?.from;
  if (user) return <Navigate to={from ? `${from.pathname}${from.search ?? ""}` : "/"} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try { await login(email, password); } catch (err) { setError(err.message); setBusy(false); }
  };
  return (
    <div className="auth">
      <form className="auth-card stack" onSubmit={submit}>
        <h1><span className="logo">▦</span> TaskFlow</h1>
        <p className="muted">Sign in to your workspace</p>
        {sessionExpired && <div className="notice" role="status">Your session has expired. Please sign in again.</div>}
        <label>Email<input type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        <p className="small">No account? <Link to="/register">Create one</Link></p>
        {SHOW_DEMO_HINT && <p className="muted small">Demo: owner@acme.test / demo12345</p>}
      </form>
    </div>
  );
}
