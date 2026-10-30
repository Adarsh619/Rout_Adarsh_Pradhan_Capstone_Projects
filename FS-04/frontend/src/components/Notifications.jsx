import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

export const POLL_MS = 30000;

export default function Notifications() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const boxRef = useRef(null);

  // Poll the unread count only while the tab is visible; catch up as soon as it's shown again.
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "hidden") return;
      api.get("/notifications/unread_count/").then((d) => setCount(d.count)).catch(() => {});
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", poll); };
  }, [slug]);

  // Close on Escape or a click outside the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    const onClick = (e) => !boxRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => { document.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onClick); };
  }, [open]);

  const toggle = async () => {
    if (open) { setOpen(false); return; }
    setError("");
    setOpen(true);
    try { setItems(await api.list("/notifications/?limit=20")); } catch (err) { setError(err.message); }
  };
  const markAll = async () => {
    try {
      await api.post("/notifications/mark_all_read/");
      setCount(0);
      setItems(items.map((n) => ({ ...n, read: true })));
    } catch (err) { setError(err.message); }
  };
  const openItem = (n) => {
    setOpen(false);
    if (!n.read) {
      api.patch(`/notifications/${n.id}/`, { read: true }).catch(() => {});
      setItems(items.map((i) => (i.id === n.id ? { ...i, read: true } : i)));
      setCount((c) => Math.max(0, c - 1));
    }
    if (n.project) navigate(`/w/${slug}/p/${n.project}/board?issue=${n.issue}`);
  };

  return (
    <div className="notif" ref={boxRef}>
      <button className="ghost" onClick={toggle} aria-expanded={open}
        aria-label={count > 0 ? `Notifications, ${count} unread` : "Notifications"}>
        🔔 {count > 0 && <span className="pill">{count}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="row between"><strong>Notifications</strong><button className="link" onClick={markAll}>Mark all read</button></div>
          {error && <div className="error small">{error}</div>}
          {!error && items.length === 0 && <p className="muted small">Nothing yet.</p>}
          {items.map((n) => (
            <button key={n.id} className={`notif-item ${n.read ? "" : "unread"}`} onClick={() => openItem(n)}>
              <div>{n.message}</div>
              <div className="muted small">{new Date(n.created_at).toLocaleString()}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
