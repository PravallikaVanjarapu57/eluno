import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { ReasonCodes, Store } from "../api/types";
import { load, save } from "../lib/storage";
import { useAuth } from "./auth";

interface Session {
  /** Only the stores the signed-in user is assigned to (the server filters them). */
  stores: Store[] | null;
  reasonCodes: ReasonCodes | null;
  storeCode: string;
  setStoreCode(code: string): void;
  error: ApiError | null;
  reload(): void;
  store: Store | undefined;
}

const Ctx = createContext<Session | null>(null);
export const useSession = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
};

/** Reference data for the signed-in user. Rendered only while signed in; it is rebuilt for each new user. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [stores, setStores] = useState<Store[] | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReasonCodes | null>(null);
  const [storeCode, setStoreCodeRaw] = useState<string>(() => load<string>("eluno.store") ?? "");
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    Promise.all([api.stores(), api.reasonCodes()])
      .then(([s, r]) => {
        if (!live) return;
        setStores(s);
        setReasonCodes(r);
        setError(null);
        // Keep the remembered store only if it is one of theirs; a user with a single store never has to choose.
        setStoreCodeRaw((cur) => (s.some((x) => x.code === cur) ? cur : s.length === 1 ? s[0]!.code : ""));
      })
      .catch((e: unknown) => live && setError(e as ApiError));
    return () => {
      live = false;
    };
  }, [tick, user?.username]);

  const setStoreCode = useCallback((c: string) => {
    setStoreCodeRaw(c);
    save("eluno.store", c);
  }, []);

  const value = useMemo<Session>(
    () => ({ stores, reasonCodes, storeCode, setStoreCode, error, reload: () => setTick((t) => t + 1), store: stores?.find((s) => s.code === storeCode) }),
    [stores, reasonCodes, storeCode, setStoreCode, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
