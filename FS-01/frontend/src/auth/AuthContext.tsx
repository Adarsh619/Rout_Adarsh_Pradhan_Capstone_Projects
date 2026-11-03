import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, refreshSession, setAccessToken, setSessionEndedHandler, type SessionResponse } from "../api/client";
import type { User } from "./types";

type Status = "loading" | "signedIn" | "signedOut";

interface AuthState {
  status: Status;
  user: User | undefined;
  login(email: string, password: string): Promise<User>;
  register(input: { name: string; email: string; password: string; role: "customer" | "vendor" }): Promise<User>;
  logout(): Promise<void>;
  setUser(user: User): void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUserState] = useState<User | undefined>();

  const signedOut = useCallback(() => {
    setAccessToken(undefined);
    setUserState(undefined);
    setStatus("signedOut");
  }, []);

  const signedIn = useCallback((session: SessionResponse<User>) => {
    setAccessToken(session.accessToken);
    setUserState(session.user);
    setStatus("signedIn");
    return session.user;
  }, []);

  // On page load, the refresh cookie (if any) restores the session without asking for the password again.
  useEffect(() => {
    let cancelled = false;
    refreshSession().then((session) => {
      if (cancelled) return;
      if (session) signedIn(session as SessionResponse<User>);
      else signedOut();
    });
    setSessionEndedHandler(signedOut);
    return () => {
      cancelled = true;
      setSessionEndedHandler(undefined);
    };
  }, [signedIn, signedOut]);

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      async login(email, password) {
        return signedIn(
          await api<SessionResponse<User>>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
        );
      },
      async register(input) {
        return signedIn(await api<SessionResponse<User>>("/auth/register", { method: "POST", body: JSON.stringify(input) }));
      },
      async logout() {
        try {
          await api("/auth/logout", { method: "POST" });
        } finally {
          signedOut();
        }
      },
      setUser: setUserState,
    }),
    [status, user, signedIn, signedOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
