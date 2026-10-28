import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { ApiError, setCsrfToken, setUnauthorizedHandler } from "../api/client";
import type { Permission, User } from "../api/types";
import { save } from "../lib/storage";

type Status = "loading" | "signedOut" | "signedIn";

interface Auth {
  status: Status;
  user: User | null;
  /** Why the user is at the sign-in screen when it is not a fresh visit. */
  notice: string | null;
  login(username: string, password: string): Promise<void>;
  logout(): Promise<void>;
  can(permission: Permission): boolean;
}

const Ctx = createContext<Auth | null>(null);
export const useAuth = () => {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAuth outside AuthProvider");
  return a;
};

// Per-device conveniences that describe the previous user's work must not outlive their session.
const FORGET = ["eluno.sale", "eluno.store"];
const forgetDeviceState = () => FORGET.forEach((k) => save(k, null));

/**
 * The session lives in an HttpOnly cookie the page cannot read. All the page holds is who the server says is signed in
 * (from /auth/me on load) and the CSRF token, in memory. Roles here only decide what to show: the server checks everything.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const signedOut = useCallback((message: string | null) => {
    setCsrfToken(null);
    setUser(null);
    setNotice(message);
    forgetDeviceState();
    setStatus("signedOut");
  }, []);

  useEffect(() => {
    api
      .me()
      .then((s) => {
        setCsrfToken(s.csrfToken);
        setUser(s.user);
        setStatus("signedIn");
      })
      .catch((e: unknown) => {
        // 401 is simply "not signed in"; anything else (server down) also lands on the sign-in screen with a hint.
        setStatus("signedOut");
        if (!(e instanceof ApiError && e.status === 401)) setNotice((e as Error).message);
      });
  }, []);

  // Any request answered 401 means the session ended (expired, signed out elsewhere, account disabled).
  useEffect(() => {
    setUnauthorizedHandler(() => signedOut("Your session has ended. Please sign in again."));
    return () => setUnauthorizedHandler(null);
  }, [signedOut]);

  const login = useCallback(async (username: string, password: string) => {
    const s = await api.login(username.trim(), password);
    forgetDeviceState(); // never inherit another person's half-finished sale
    setCsrfToken(s.csrfToken);
    setUser(s.user);
    setNotice(null);
    setStatus("signedIn");
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the server-side session may already be gone; the cookie is cleared either way */
    }
    signedOut(null);
  }, [signedOut]);

  const value = useMemo<Auth>(() => ({ status, user, notice, login, logout, can: (p) => !!user?.permissions.includes(p) }), [status, user, notice, login, logout]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
