import type { ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router";
import { useAuth } from "./AuthContext";
import { HOME_BY_ROLE, ROLE_LABEL, type Role } from "./types";

// Guards a page: signed-out visitors go to sign-in (and come back afterwards); a signed-in user with the
// wrong role is told which account type the page is for, instead of seeing a blank or broken page.
export function RequireAuth({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === "loading") {
    return <p className="py-20 text-center text-slate-500">Loading…</p>;
  }
  if (status === "signedOut" || !user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (roles && !roles.includes(user.role)) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-2xl font-semibold">This page isn't for your account</h1>
        <p className="mt-2 text-slate-600">
          It's for {roles.map((r) => ROLE_LABEL[r].toLowerCase()).join(" or ")} accounts. You're signed in as a{" "}
          {ROLE_LABEL[user.role].toLowerCase()}.
        </p>
        <Link
          to={HOME_BY_ROLE[user.role]}
          className="mt-6 inline-block rounded-lg bg-brand-600 px-4 py-2 text-white hover:bg-brand-700"
        >
          Go to your dashboard
        </Link>
      </div>
    );
  }
  return <>{children}</>;
}
