import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api";

export default function Notifications() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState([]);

  useEffect(() => {
    const poll = () => api.get("/notifications/unread_count/").then((d) => setCount(d.count)).catch(() => {});
    poll();
    const id = setInterval(poll, 30000);
    return () => clearInterval(id);
  }, [slug]);

  const toggle = async () => {
    if (!open) setItems(await api.list("/notifications/?limit=20"));
    setOpen(!open);
  };
  const markAll = async () => {
    await api.post("/notifications/mark_all_read/");
    setCount(0);
    setItems(items.map((n) => ({ ...n, read: true })));
  };

  return (
    <div className="notif">
      <button className="ghost" onClick={toggle} aria-label="Notifications">
        🔔 {count > 0 && <span className="pill">{count}</span>}
      </button>
      {open && (
        <div className="dropdown">
          <div className="row between"><strong>Notifications</strong><button className="link" onClick={markAll}>Mark all read</button></div>
          {items.length === 0 && <p className="muted small">Nothing yet.</p>}
          {items.map((n) => (
            <div key={n.id} className={`notif-item ${n.read ? "" : "unread"}`}
              onClick={() => { setOpen(false); if (n.project) navigate(`/w/${slug}/p/${n.project}/board?issue=${n.issue}`); }}>
              <div>{n.message}</div>
              <div className="muted small">{new Date(n.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
