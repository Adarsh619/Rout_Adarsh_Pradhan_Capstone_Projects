import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { HOME_BY_ROLE } from "../auth/types";
import { Field, FormError, SubmitButton } from "../components/Field";
import { safeNext } from "./LoginPage";

type AccountType = "customer" | "vendor";

const TYPES: { value: AccountType; title: string; text: string }[] = [
  { value: "customer", title: "I want to shop", text: "Buy from many stores with one cart." },
  { value: "vendor", title: "I want to sell", text: "Open a store and list your products." },
];

export function RegisterPage() {
  const { register, status, user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const [role, setRole] = useState<AccountType>(params.get("type") === "vendor" ? "vendor" : "customer");
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  if (status === "signedIn" && user) return <Navigate to={HOME_BY_ROLE[user.role]} replace />;

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setFieldErrors({});
    setBusy(true);
    try {
      const u = await register({ ...form, role });
      navigate(next ?? HOME_BY_ROLE[u.role], { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0) setFieldErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Can't reach the server. Check your connection and try again.");
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-semibold">Create your account</h1>
      <p className="mt-1 text-sm text-slate-600">
        Already have one?{" "}
        <Link to="/login" className="text-brand-700 underline">
          Sign in
        </Link>
      </p>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        <fieldset>
          <legend className="text-sm font-medium text-slate-700">Account type</legend>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {TYPES.map((t) => (
              <label
                key={t.value}
                className={`cursor-pointer rounded-lg border p-3 text-sm ${
                  role === t.value ? "border-brand-600 bg-brand-50" : "border-slate-300 bg-white"
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={t.value}
                  checked={role === t.value}
                  onChange={() => setRole(t.value)}
                  className="sr-only"
                />
                <span className="block font-medium">{t.title}</span>
                <span className="mt-1 block text-xs text-slate-600">{t.text}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <FormError message={error} />
        <Field label="Full name" autoComplete="name" required value={form.name} onChange={set("name")} error={fieldErrors.name} />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={form.email}
          onChange={set("email")}
          error={fieldErrors.email}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          required
          value={form.password}
          onChange={set("password")}
          error={fieldErrors.password}
          hint="At least 10 characters, with a letter and a number."
        />
        <SubmitButton busy={busy}>{role === "vendor" ? "Create seller account" : "Create account"}</SubmitButton>
      </form>
    </div>
  );
}
