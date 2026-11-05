import { useEffect } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from "react-router";
import { useCart } from "../api/cart";
import { useAuth } from "../auth/AuthContext";
import { HOME_BY_ROLE, ROLE_LABEL } from "../auth/types";
import { SearchBox } from "./SearchBox";

function CartLink() {
  const { data } = useCart();
  const count = data?.itemCount ?? 0;
  return (
    <NavLink to="/cart" aria-label={count ? `Cart, ${count} ${count === 1 ? "item" : "items"}` : "Cart"} className="relative font-medium text-slate-700 hover:text-brand-700">
      Cart
      {count > 0 && (
        <span className="ml-1 rounded-full bg-brand-600 px-1.5 py-0.5 text-xs text-white">
          {count}
          <span className="sr-only"> items</span>
        </span>
      )}
    </NavLink>
  );
}

export function Layout() {
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const navigationType = useNavigationType();

  // A new page starts at the top. Only the path counts, so changing search filters (the query string) keeps the
  // shopper where they are; Back and Forward ("POP") are left alone so the browser restores the old position.
  useEffect(() => {
    if (navigationType !== "POP") window.scrollTo(0, 0);
  }, [pathname, navigationType]);

  // Leave the (possibly protected) page first, so it doesn't redirect to sign-in as the session ends.
  const signOut = async () => {
    navigate("/", { replace: true });
    await logout();
  };

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:flex-nowrap">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-brand-700">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            ShopSphere
          </Link>
          {/* Its own full-width row on phones, between the logo and the account links on wider screens. */}
          <div className="order-last flex w-full justify-center sm:order-none sm:flex-1">
            <SearchBox />
          </div>
          <nav aria-label="Account" className="flex items-center gap-3 text-sm">
            {(status === "signedOut" || user?.role === "customer") && <CartLink />}
            {status === "signedIn" && user ? (
              <>
                {user.role === "customer" && (
                  <NavLink to="/orders" className="font-medium text-slate-700 hover:text-brand-700">
                    Orders
                  </NavLink>
                )}
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
