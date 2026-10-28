import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { ReasonCodes, Staff, Store } from "../api/types";
import { load, save } from "../lib/storage";

interface Session {
  stores: Store[] | null;
  staff: Staff[] | null;
  reasonCodes: ReasonCodes | null;
  storeCode: string;
  staffId: string;
  setStoreCode(code: string): void;
  setStaffId(id: string): void;
  error: ApiError | null;
  reload(): void;
  store: Store | undefined;
  currentStaff: Staff | undefined;
}

const Ctx = createContext<Session | null>(null);
export const useSession = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
};

export function SessionProvider({ children }: { children: ReactNode }) {
  const [stores, setStores] = useState<Store[] | null>(null);
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [reasonCodes, setReasonCodes] = useState<ReasonCodes | null>(null);
  const [storeCode, setStoreCodeRaw] = useState<string>(() => load<string>("eluno.store") ?? "");
  const [staffId, setStaffIdRaw] = useState<string>(() => load<string>("eluno.staff") ?? "");
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
        setStoreCodeRaw((cur) => (s.some((x) => x.code === cur) ? cur : ""));
      })
      .catch((e: unknown) => live && setError(e as ApiError));
    return () => {
      live = false;
    };
  }, [tick]);

  useEffect(() => {
    setStaff(null);
    if (!storeCode) return;
    let live = true;
    api
      .staff(storeCode)
      .then((s) => {
        if (!live) return;
        setStaff(s);
        setStaffIdRaw((cur) => (s.some((x) => x.staffId === cur) ? cur : ""));
      })
      .catch((e: unknown) => live && setError(e as ApiError));
    return () => {
      live = false;
    };
  }, [storeCode, tick]);

  const setStoreCode = useCallback((c: string) => {
    setStoreCodeRaw(c);
    setStaffIdRaw("");
    save("eluno.store", c);
    save("eluno.staff", "");
  }, []);
  const setStaffId = useCallback((id: string) => {
    setStaffIdRaw(id);
    save("eluno.staff", id);
  }, []);

  const value = useMemo<Session>(
    () => ({
      stores, staff, reasonCodes, storeCode, staffId, setStoreCode, setStaffId, error, reload: () => setTick((t) => t + 1),
      store: stores?.find((s) => s.code === storeCode),
      currentStaff: staff?.find((s) => s.staffId === staffId),
    }),
    [stores, staff, reasonCodes, storeCode, staffId, setStoreCode, setStaffId, error],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
