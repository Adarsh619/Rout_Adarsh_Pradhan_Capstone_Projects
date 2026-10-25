import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try { await login(email, password); navigate("/"); } catch (err) { setError(err.message); }
  };
  return (
    <div className="auth">
      <form className="auth-card stack" onSubmit={submit}>
        <h1><span className="logo">▦</span> TaskFlow</h1>
        <p className="muted">Sign in to your workspace</p>
        <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Sign in</button>
        <p className="small">No account? <Link to="/register">Create one</Link></p>
        <p className="muted small">Demo: owner@acme.test / demo12345</p>
      </form>
    </div>
  );
}
