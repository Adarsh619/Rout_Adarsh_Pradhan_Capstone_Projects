import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { HOME_BY_ROLE } from "../auth/types";
import { Field, FormError, SubmitButton } from "../components/Field";

// Only same-site paths are accepted for ?next=, so a crafted link can't send users to another website.
export const safeNext = (next: string | null): string | undefined =>
  next && next.startsWith("/") && !next.startsWith("//") ? next : undefined;

const DEMO_HINT = import.meta.env.VITE_DEMO_HINT !== "false";

export function LoginPage() {
  const { login, status, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (status === "signedIn" && user) return <Navigate to={next ?? HOME_BY_ROLE[user.role]} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      const u = await login(email, password);
      navigate(next ?? HOME_BY_ROLE[u.role], { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Can't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-slate-600">
        New here?{" "}
        <Link to={`/register${next ? `?next=${encodeURIComponent(next)}` : ""}`} className="text-brand-700 underline">
          Create an account
        </Link>
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <FormError message={error} />
        <Field label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <SubmitButton busy={busy}>Sign in</SubmitButton>
      </form>
      {DEMO_HINT && (
        <div className="mt-6 rounded-lg border border-slate-200 bg-white p-4 text-xs text-slate-600">
          <p className="font-medium text-slate-700">Demo accounts</p>
          <p className="mt-1">customer@shopsphere.test · vendor@shopsphere.test · admin@shopsphere.test</p>
          <p className="mt-1">Password: the demo password from the project's setup notes.</p>
        </div>
      )}
    </div>
  );
}
