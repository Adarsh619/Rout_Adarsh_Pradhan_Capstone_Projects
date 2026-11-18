import { Link, useLocation } from "react-router-dom";

// Shown for any URL the app doesn't know, instead of silently redirecting.
export default function NotFound({ home = "/", homeLabel = "Go to your workspaces" }) {
  const { pathname } = useLocation();
  return (
    <div className="center empty-state">
      <div className="empty-code">404</div>
      <h2>Page not found</h2>
      <p className="muted">There's nothing at <code>{pathname}</code>. The link may be old or mistyped.</p>
      <Link className="button primary" to={home}>{homeLabel}</Link>
    </div>
  );
}
