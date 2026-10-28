import { useCallback, useEffect, useRef, useState } from "react";

/** Load something when the inputs change; an older answer never overwrites a newer one. `reload` runs the same request again. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): { data: T | null; error: unknown; loading: boolean; reload(): void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const mine = ++latest.current;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => { if (mine === latest.current) { setData(d); setLoading(false); } },
      (e: unknown) => { if (mine === latest.current) { setError(e); setLoading(false); } },
    );
    return () => { latest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload: useCallback(() => setTick((t) => t + 1), []) };
}

/** A fresh id for one form, so a deliberate retry of the same save cannot create a second record. */
export const newRef = (): string => (globalThis.crypto?.randomUUID?.() ?? `ref-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
