import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { ROLE_LABEL, type User } from "../auth/types";
import { Field, FormError, SubmitButton } from "../components/Field";

function Notice({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      {text}
    </p>
  );
}

function ProfileForm({ user }: { user: User }) {
  const { setUser } = useAuth();
  const [name, setName] = useState(user.name);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setSaved(undefined);
    setBusy(true);
    try {
      const res = await api<{ user: User }>("/account", { method: "PATCH", body: JSON.stringify({ name }) });
      setUser(res.user);
      setSaved("Your name has been updated.");
    } catch (err) {
      setError(err instanceof ApiError ? (err.fieldErrors.name ?? err.message) : "Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Notice text={saved} />
      <Field label="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} error={error} />
      <Field label="Email" value={user.email} disabled hint="Your email can't be changed." />
      <div className="max-w-40">
        <SubmitButton busy={busy}>Save</SubmitButton>
      </div>
    </form>
  );
}

function PasswordForm() {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "" });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setError(undefined);
    setSaved(undefined);
    setBusy(true);
    try {
      const res = await api<{ signedOutSessions: number }>("/account/password", {
        method: "POST",
        body: JSON.stringify(form),
      });
      setForm({ currentPassword: "", newPassword: "" });
      setSaved(
        res.signedOutSessions > 0
          ? `Password changed. ${res.signedOutSessions} other ${res.signedOutSessions === 1 ? "device was" : "devices were"} signed out.`
          : "Password changed.",
      );
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0) setErrors(err.fieldErrors);
      else setError(err instanceof ApiError ? err.message : "Couldn't change the password. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Notice text={saved} />
      <FormError message={error} />
      <Field
        label="Current password"
        type="password"
        autoComplete="current-password"
        value={form.currentPassword}
        onChange={(e) => setForm((f) => ({ ...f, currentPassword: e.target.value }))}
        error={errors.currentPassword}
      />
      <Field
        label="New password"
        type="password"
        autoComplete="new-password"
        value={form.newPassword}
        onChange={(e) => setForm((f) => ({ ...f, newPassword: e.target.value }))}
        error={errors.newPassword}
        hint="At least 10 characters, with a letter and a number. Other devices will be signed out."
      />
      <div className="max-w-52">
        <SubmitButton busy={busy}>Change password</SubmitButton>
      </div>
    </form>
  );
}

export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Your account</h1>
        <p className="mt-1 text-sm text-slate-600">
          {ROLE_LABEL[user.role]} account · member since {new Date(user.createdAt).toLocaleDateString("en-IN")}
        </p>
      </div>
      {user.role === "customer" && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="font-semibold">Your orders</h2>
          <p className="mt-2 text-sm text-slate-600">You haven't ordered anything yet. Orders will appear here.</p>
        </section>
      )}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-semibold">Profile</h2>
        <ProfileForm user={user} />
      </section>
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 font-semibold">Password</h2>
        <PasswordForm />
      </section>
    </div>
  );
}
