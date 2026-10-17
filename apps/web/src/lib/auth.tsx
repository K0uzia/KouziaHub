import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, SESSION_EXPIRED_EVENT } from "@/lib/api";

export type User = { id: string; email: string; name: string | null };

type AuthCtx = {
  user: User | null;
  loading: boolean;
  /** Le hub n'a pas répondu au premier chargement (session pas encore vérifiée). */
  unreachable: boolean;
  /** "mfa" : mot de passe accepté, code de la double authentification attendu. */
  login: (email: string, password: string) => Promise<"ok" | "mfa">;
  verifySecondFactor: (input: { code: string } | { recoveryCode: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const data = await api<{ user: User | null }>("/api/auth/me");
      setUser(data.user);
      setUnreachable(false);
    } catch (error) {
      if ((error as { status?: unknown }).status === 401) {
        setUser(null);
        setUnreachable(false);
      } else {
        setUnreachable(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Session expirée pendant l'usage (401 sur une route protégée) : retour à la connexion.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const data = await api<{ user: User } | { mfaRequired: true }>("/api/auth/login", {
      method: "POST",
      json: { email, password },
    });
    if ("mfaRequired" in data) return "mfa" as const;
    setUser(data.user);
    return "ok" as const;
  }, []);

  const verifySecondFactor = useCallback(async (input: { code: string } | { recoveryCode: string }) => {
    const data = await api<{ user: User }>("/api/auth/2fa", { method: "POST", json: input });
    setUser(data.user);
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, loading, unreachable, login, verifySecondFactor, logout, refresh }),
    [user, loading, unreachable, login, verifySecondFactor, logout, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth hors AuthProvider");
  return ctx;
}
