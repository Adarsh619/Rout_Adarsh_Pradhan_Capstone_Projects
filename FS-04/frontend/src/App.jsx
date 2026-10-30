import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useAuth } from "./auth";
import Layout from "./components/Layout";
import Login from "./pages/Login";
import Register from "./pages/Register";
import Workspaces from "./pages/Workspaces";
import Projects from "./pages/Projects";
import Board from "./pages/Board";
import Sprints from "./pages/Sprints";
import Members from "./pages/Members";
import Workflows from "./pages/Workflows";
import Webhooks from "./pages/Webhooks";
import AuditLog from "./pages/AuditLog";
import Reports from "./pages/Reports";
import Billing from "./pages/Billing";
import MockCheckout from "./pages/MockCheckout";
import NotFound from "./pages/NotFound";

// Signed-out visitors go to the login page, which sends them back here afterwards.
export function Private({ children }) {
  const { user, loading, bootError, retry } = useAuth();
  const location = useLocation();
  if (loading) return <div className="center muted">Loading…</div>;
  if (bootError) {
    return <div className="center empty-state"><p>{bootError}</p><button className="primary" onClick={retry}>Try again</button></div>;
  }
  return user ? children : <Navigate to="/login" replace state={{ from: location }} />;
}

function WorkspaceNotFound() {
  const { slug } = useParams();
  return <NotFound home={`/w/${slug}`} homeLabel="Back to projects" />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/" element={<Private><Workspaces /></Private>} />
      <Route path="/w/:slug" element={<Private><Layout /></Private>}>
        <Route index element={<Projects />} />
        <Route path="p/:projectId/board" element={<Board />} />
        <Route path="p/:projectId/sprints" element={<Sprints />} />
        <Route path="members" element={<Members />} />
        <Route path="workflows" element={<Workflows />} />
        <Route path="webhooks" element={<Webhooks />} />
        <Route path="audit" element={<AuditLog />} />
        <Route path="reports" element={<Reports />} />
        <Route path="billing" element={<Billing />} />
        <Route path="billing/checkout" element={<MockCheckout />} />
        <Route path="*" element={<WorkspaceNotFound />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
