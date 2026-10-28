import { rmSync } from "node:fs";

/**
 * The mock keeps its state in memory, so a till database that outlives it describes orders Shopify no longer has
 * (day-end would report MISSING_IN_SHOPIFY). When this process owns the mock and TILL_RESET_DB=1, start from an empty
 * till database too, so both always begin together. Returns the files that were removed.
 */
export function resetDbFiles(dbPath: string, enabled: boolean): string[] {
  if (!enabled || dbPath === ":memory:") return [];
  const removed: string[] = [];
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      rmSync(dbPath + suffix, { force: false });
      removed.push(dbPath + suffix);
    } catch {
      /* not there */
    }
  }
  return removed;
}
