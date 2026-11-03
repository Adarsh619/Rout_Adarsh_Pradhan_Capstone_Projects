import { Link, NavLink, Outlet, useNavigate } from "react-router";
import { useAuth } from "../auth/AuthContext";
import { HOME_BY_ROLE, ROLE_LABEL } from "../auth/types";

export function Layout() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();

  // Leave the (possibly protected) page first, so it doesn't redirect to sign-in as the session ends.
  const signOut = async () => {
    navigate("/", { replace: true });
    await logout();
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-brand-700">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            ShopSphere
          </Link>
          <nav aria-label="Account" className="flex items-center gap-3 text-sm">
            {status === "signedIn" && user ? (
              <>
                <NavLink to={HOME_BY_ROLE[user.role]} className="font-medium text-slate-700 hover:text-brand-700">
                  {user.role === "customer" ? "My account" : "Dashboard"}
                </NavLink>
                <span className="hidden text-slate-500 sm:inline">
                  {user.name} · {ROLE_LABEL[user.role]}
                </span>
                <button type="button" onClick={signOut} className="rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50">
                  Sign out
                </button>
              </>
            ) : status === "signedOut" ? (
              <>
                <NavLink to="/login" className="font-medium text-slate-700 hover:text-brand-700">
                  Sign in
                </NavLink>
                <NavLink to="/register" className="rounded-lg bg-brand-600 px-3 py-1.5 font-medium text-white hover:bg-brand-700">
                  Create account
                </NavLink>
              </>
            ) : null}
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 bg-white py-6 text-center text-sm text-slate-500">
        ShopSphere · test mode only, no real payments
      </footer>
    </div>
  );
}
