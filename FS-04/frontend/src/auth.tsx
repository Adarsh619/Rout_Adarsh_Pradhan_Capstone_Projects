import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, messageOf, request, SESSION_EXPIRED, statusOf, tokens } from "./api";
import type { Me, TokenPair } from "./types";

export interface RegisterPayload {
  email: string;
  password: string;
  full_name?: string;
  workspace_name?: string;
}
export interface RegisterResult extends TokenPair {
  user: Me;
  workspace: string | null;
}

export interface AuthState {
  user: Me | null;
  loading: boolean;
  bootError: string;
  retry: () => Promise<void>;
  sessionExpired: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (payload: RegisterPayload) => Promise<RegisterResult>;
  logout: () => void;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  updateProfile: (fields: Partial<Pick<Me, "full_name">>) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(Boolean(tokens.access));
  // Set when the profile couldn't load for a reason other than a bad token (server down, offline).
  const [bootError, setBootError] = useState("");
  const [sessionExpired, setSessionExpired] = useState(false);

  const loadMe = useCallback(async () => {
    setLoading(true);
    setBootError("");
    try {
      setUser(await api.get<Me>("/auth/me/"));
    } catch (err) {
      // Only a rejected token signs you out; a network hiccup keeps the tokens so "Try again" works.
      const status = statusOf(err);
      if (status === 401 || status === 403) { tokens.clear(); setUser(null); }
      else setBootError(messageOf(err));
    }
    setLoading(false);
  }, []);

  useEffect(() => { if (tokens.access) loadMe(); }, [loadMe]);

  useEffect(() => {
    const expire = () => { setUser(null); setSessionExpired(true); };
    window.addEventListener(SESSION_EXPIRED, expire);
    return () => window.removeEventListener(SESSION_EXPIRED, expire);
  }, []);

  const login = async (email: string, password: string) => {
    const t = await request<TokenPair>("/auth/token/", { method: "POST", body: { email, password }, retry: false });
    tokens.set(t);
    setSessionExpired(false);
    await loadMe();
  };
  const register = async (payload: RegisterPayload) => {
    const r = await request<RegisterResult>("/auth/register/", { method: "POST", body: payload, retry: false });
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

  // The server revokes every session on a password change and returns a new pair for this one.
  const changePassword = async (currentPassword: string, newPassword: string) => {
    const t = await api.post<TokenPair>("/auth/password/", { current_password: currentPassword, new_password: newPassword });
    tokens.set(t);
  };
  const updateProfile = async (fields: Partial<Pick<Me, "full_name">>) => setUser(await api.patch<Me>("/auth/me/", fields));

  const value: AuthState = { user, loading, bootError, retry: loadMe, sessionExpired, login, register, logout, changePassword, updateProfile };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = (): AuthState => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
};
