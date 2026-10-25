import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ full_name: "", email: "", password: "", workspace_name: "" });
  const [error, setError] = useState("");
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const submit = async (e) => {
    e.preventDefault();
    setError("");
    try {
      const r = await register(form);
      navigate(r.workspace ? `/w/${r.workspace}` : "/");
    } catch (err) { setError(err.message); }
  };
  return (
    <div className="auth">
      <form className="auth-card stack" onSubmit={submit}>
        <h1><span className="logo">▦</span> TaskFlow</h1>
        <p className="muted">Create your account and company workspace</p>
        <label>Full name<input value={form.full_name} onChange={set("full_name")} /></label>
        <label>Email<input type="email" required value={form.email} onChange={set("email")} /></label>
        <label>Password<input type="password" required minLength={8} value={form.password} onChange={set("password")} /></label>
        <label>Company / workspace name<input value={form.workspace_name} onChange={set("workspace_name")} placeholder="Acme Corp" /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Create account</button>
        <p className="small">Already registered? <Link to="/login">Sign in</Link></p>
      </form>
    </div>
  );
}
