import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { can, useWorkspace } from "../workspace";

export default function Members() {
  // The member list lives in the workspace context, so the board and audit filters stay current too.
  const { role, user, workspace, members, reloadMembers, reloadWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [newRole, setNewRole] = useState("member");
  const [error, setError] = useState("");
  const admin = can(role, "admin");
  const owner = role === "owner";
  // Admins manage members and viewers; only the owner can grant, change or remove the admin role.
  const assignable = owner ? ["viewer", "member", "admin"] : ["viewer", "member"];
  const canManage = (m) => admin && m.role !== "owner" && (owner || m.role !== "admin");
  const load = reloadMembers;
  useEffect(() => { reloadMembers(); }, [reloadMembers]);

  const act = (fn) => async (...a) => { setError(""); try { await fn(...a); load(); } catch (e) { setError(e.message); } };
  const add = async (e) => {
    e.preventDefault();
    setError("");
    try { await api.post("/members/", { email, role: newRole }); setEmail(""); load(); }
    catch (err) { setError(err.status === 402 ? `${err.message} → see Billing.` : err.message); }
  };
  const remove = (m) => act(async () => {
    if (!window.confirm(`Remove ${m.user.email} from ${workspace.name}? Their open issues become unassigned.`)) return;
    await api.del(`/members/${m.id}/`);
  })();
  const transfer = (m) => act(async () => {
    if (!window.confirm(`Make ${m.user.email} the owner of ${workspace.name}? You will become an admin.`)) return;
    await api.post(`/workspaces/${workspace.slug}/transfer/`, { user_id: m.user.id });
    await reloadWorkspace();
  })();
  const leave = async () => {
    if (!window.confirm(`Leave ${workspace.name}? Your open issues will be unassigned.`)) return;
    setError("");
    try { await api.post("/members/leave/"); navigate("/"); } catch (e) { setError(e.message); }
  };

  return (
    <div className="stack">
      <h2>Members</h2>
      <p className="muted small">Roles: <b>viewer</b> read-only · <b>member</b> work on issues, delete the ones they created ·<b>admin</b> manage projects, workflows, webhooks, members · <b>owner</b> billing, admins, ownership.</p>
      {error && <div className="error" role="alert">{error}</div>}
      <div className="table-wrap panel">
      <table className="table">
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th /></tr></thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.user.display_name}</td>
              <td>{m.user.email}</td>
              <td>
                {canManage(m) ? (
                  <select aria-label={`Role of ${m.user.email}`} value={m.role} onChange={(e) => act(() => api.patch(`/members/${m.id}/`, { role: e.target.value }))()}>
                    {assignable.map((r) => <option key={r}>{r}</option>)}
                  </select>
                ) : <span className="badge">{m.role}</span>}
              </td>
              <td className="row gap">
                {owner && m.user.id !== user.id && <button className="link" onClick={() => transfer(m)}>Make owner</button>}
                {canManage(m) && <button className="link danger-text" onClick={() => remove(m)}>Remove</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {admin && (
        <form className="row gap panel" onSubmit={add}>
          <input type="email" required aria-label="Email of the person to add" placeholder="colleague@company.com (must have an account)" value={email} onChange={(e) => setEmail(e.target.value)} style={{ flex: 1 }} />
          <select value={newRole} onChange={(e) => setNewRole(e.target.value)}>{assignable.map((r) => <option key={r}>{r}</option>)}</select>
          <button className="primary">Add member</button>
        </form>
      )}
      {!owner && (
        <div><button className="danger" onClick={leave}>Leave workspace</button></div>
      )}
    </div>
  );
}
