import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, request, SESSION_EXPIRED, tokens } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(tokens.access));
  // Set when the profile couldn't load for a reason other than a bad token (server down, offline).
  const [bootError, setBootError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadMe = useCallback(async () => {
    setLoading(true);
    setBootError("");
    try {
      setUser(await api.get("/auth/me/"));
    } catch (err) {
      // Only a rejected token signs you out; a network hiccup keeps the tokens so "Try again" works.
      if (err.status === 401 || err.status === 403) { tokens.clear(); setUser(null); }
      else setBootError(err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (tokens.access) loadMe(); }, [loadMe]);

  useEffect(() => {
    const expire = () => { setUser(null); setSessionExpired(true); };
    window.addEventListener(SESSION_EXPIRED, expire);
    return () => window.removeEventListener(SESSION_EXPIRED, expire);
  }, []);

  const login = async (email, password) => {
    const t = await request("/auth/token/", { method: "POST", body: { email, password }, retry: false });
    tokens.set(t);
    setSessionExpired(false);
    await loadMe();
  };
  const register = async (payload) => {
    const r = await request("/auth/register/", { method: "POST", body: payload, retry: false });
    tokens.set(r);
    setSessionExpired(false);
    setUser(r.user);
    return r;
  };
  const logout = () => {
    // Revoke the refresh token server-side; sign out locally even if that call fails.
    if (tokens.refresh) {
      request("/auth/logout/", { method: "POST", body: { refresh: tokens.refresh }, retry: false }).catch(() => {});
    }
    tokens.clear();
    setSessionExpired(false);
    setUser(null);
  };

  const value = { user, loading, bootError, retry: loadMe, sessionExpired, login, register, logout };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
