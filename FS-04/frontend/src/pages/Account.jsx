import { useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "../auth";

// DRF returns {"field": ["message"]}; show each message next to its field.
const fieldError = (data, field) => (Array.isArray(data?.[field]) ? data[field].join(" ") : data?.[field]) || "";

export default function Account() {
  const { user, updateProfile, changePassword } = useAuth();
  const location = useLocation();
  const back = location.state?.from || "/";

  const [name, setName] = useState(user.full_name ?? "");
  const [nameMsg, setNameMsg] = useState("");
  const [nameError, setNameError] = useState("");
  const [savingName, setSavingName] = useState(false);

  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwErrors, setPwErrors] = useState({});
  const [pwMsg, setPwMsg] = useState("");
  const [savingPw, setSavingPw] = useState(false);
  const mismatch = pw.confirm !== "" && pw.next !== pw.confirm;

  const saveName = async (e) => {
    e.preventDefault();
    setNameMsg("");
    setNameError("");
    setSavingName(true);
    try { await updateProfile({ full_name: name.trim() }); setNameMsg("Name saved."); }
    catch (err) { setNameError(fieldError(err.data, "full_name") || err.message); }
    setSavingName(false);
  };

  const savePassword = async (e) => {
    e.preventDefault();
    if (mismatch) return;
    setPwMsg("");
    setPwErrors({});
    setSavingPw(true);
    try {
      await changePassword(pw.current, pw.next);
      setPw({ current: "", next: "", confirm: "" });
      setPwMsg("Password changed. You're still signed in here; any other devices have been signed out.");
    } catch (err) {
      const current = fieldError(err.data, "current_password");
      const next = fieldError(err.data, "new_password");
      setPwErrors(current || next ? { current, next } : { form: err.message });
    }
    setSavingPw(false);
  };

  return (
    <div className="auth">
      <div className="auth-card stack account">
        <div className="row between">
          <h2>Your account</h2>
          <Link to={back} className="small">← Back</Link>
        </div>

        <form className="stack" onSubmit={saveName}>
          <h3>Profile</h3>
          <label>Email<input value={user.email} disabled /></label>
          <label>Full name<input autoComplete="name" value={name} maxLength={150} onChange={(e) => setName(e.target.value)} /></label>
          {nameError && <div className="error" role="alert">{nameError}</div>}
          {nameMsg && <div className="toast static" role="status">{nameMsg}</div>}
          <button className="primary" disabled={savingName || name.trim() === (user.full_name ?? "")}>{savingName ? "Saving…" : "Save name"}</button>
        </form>

        <form className="stack" onSubmit={savePassword}>
          <h3>Change password</h3>
          {/* Lets password managers tie the new password to this account. */}
          <input type="email" autoComplete="username" value={user.email} readOnly hidden />
          {/* Hints and errors sit outside the <label>, so the field's name stays just "New password". */}
          <div className="field">
            <label>Current password
              <input type="password" required autoComplete="current-password" value={pw.current} aria-describedby="current-password-error"
                aria-invalid={Boolean(pwErrors.current)} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </label>
            {pwErrors.current && <span id="current-password-error" className="field-error">{pwErrors.current}</span>}
          </div>
          <div className="field">
            <label>New password
              <input type="password" required minLength={8} autoComplete="new-password" value={pw.next}
                aria-invalid={Boolean(pwErrors.next)} aria-describedby="new-password-help" onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </label>
            {pwErrors.next
              ? <span id="new-password-help" className="field-error">{pwErrors.next}</span>
              : <span id="new-password-help" className="muted small">At least 8 characters, not only numbers, not a common password and not like your email.</span>}
          </div>
          <div className="field">
            <label>Confirm new password
              <input type="password" required autoComplete="new-password" value={pw.confirm} aria-describedby="confirm-password-error"
                aria-invalid={mismatch} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} />
            </label>
            {mismatch && <span id="confirm-password-error" className="field-error">The passwords don't match.</span>}
          </div>
          {pwErrors.form && <div className="error" role="alert">{pwErrors.form}</div>}
          {pwMsg && <div className="toast static" role="status">{pwMsg}</div>}
          <button className="primary" disabled={savingPw || mismatch}>{savingPw ? "Changing…" : "Change password"}</button>
        </form>
      </div>
    </div>
  );
}
