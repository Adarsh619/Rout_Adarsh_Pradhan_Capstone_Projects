import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, request, tokens } from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(Boolean(tokens.access));

  const loadMe = useCallback(async () => {
    try { setUser(await api.get("/auth/me/")); } catch { tokens.clear(); setUser(null); }
    setLoading(false);
  }, []);

  useEffect(() => { if (tokens.access) loadMe(); }, [loadMe]);

  const login = async (email, password) => {
    const t = await request("/auth/token/", { method: "POST", body: { email, password }, retry: false });
    tokens.set(t);
    await loadMe();
  };
  const register = async (payload) => {
    const r = await request("/auth/register/", { method: "POST", body: payload, retry: false });
    tokens.set(r);
    setUser(r.user);
    return r;
  };
  const logout = () => { tokens.clear(); setUser(null); };

  return <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
