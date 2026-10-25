import { useEffect, useState } from "react";
import { api } from "../api";
import { can, useWorkspace } from "../workspace";

export default function Members() {
  const { role } = useWorkspace();
  const [members, setMembers] = useState([]);
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState("member");
  const [error, setError] = useState("");
  const admin = can(role, "admin");
  const load = () => api.list("/members/").then(setMembers);
  useEffect(() => { load(); }, []);

  const act = (fn) => async (...a) => { setError(""); try { await fn(...a); load(); } catch (e) { setError(e.message); } };
  const add = act(async (e) => { e.preventDefault(); await api.post("/members/", { email, role: newRole }); setEmail(""); });

  return (
    <div className="stack">
      <h2>Members</h2>
      <p className="muted small">Roles: <b>viewer</b> read-only · <b>member</b> work on issues · <b>admin</b> manage projects, workflows, webhooks · <b>owner</b> billing.</p>
      {error && <div className="error">{error}</div>}
      <table className="table panel">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.user.display_name}</td>
              <td>{m.user.email}</td>
              <td>
                {admin && m.role !== "owner" ? (
                  <select value={m.role} onChange={(e) => act(() => api.patch(`/members/${m.id}/`, { role: e.target.value }))()}>
                    {["viewer", "member", "admin"].map((r) => <option key={r}>{r}</option>)}
                  </select>
                ) : <span className="badge">{m.role}</span>}
              </td>
              <td>{admin && m.role !== "owner" && <button className="link danger-text" onClick={act(() => api.del(`/members/${m.id}/`))}>Remove</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {admin && (
        <form className="row gap panel" onSubmit={add}>
          <input type="email" required placeholder="colleague@company.com (must have an account)" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>{["viewer", "member", "admin"].map((r) => <option key={r}>{r}</option>)}</select>
          <button className="primary">Add member</button>
        </form>
      )}
    </div>
  );
}
