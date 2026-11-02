import { Link, Outlet } from "react-router";

export function Layout() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2 text-lg font-semibold text-brand-700">
            <img src="/favicon.svg" alt="" className="h-7 w-7" />
            ShopSphere
          </Link>
          <nav className="text-sm text-slate-500">Marketplace · Day 1 preview</nav>
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
