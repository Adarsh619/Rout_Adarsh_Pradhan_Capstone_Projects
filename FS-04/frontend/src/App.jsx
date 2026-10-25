import { Navigate, Route, Routes } from "react-router-dom";
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

function Private({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  return user ? children : <Navigate to="/login" replace />;
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
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
