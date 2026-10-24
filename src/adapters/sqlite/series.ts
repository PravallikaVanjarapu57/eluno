import type { Db } from "./db.js";

// Gapless numbering. Call inside the same transaction that writes the row the number belongs to.

export function hasSeries(db: Db, storeCode: string, kind: "INV" | "CN", prefix: string): boolean {
  return !!db.prepare("SELECT 1 FROM invoice_series WHERE store_code = ? AND kind = ? AND prefix = ?").get(storeCode, kind, prefix);
}

export function initSeries(db: Db, storeCode: string, kind: "INV" | "CN", prefix: string, nextNo: number): void {
  db.prepare("INSERT OR IGNORE INTO invoice_series (store_code, kind, prefix, next_no) VALUES (?, ?, ?, ?)").run(storeCode, kind, prefix, nextNo);
}

export function takeNext(db: Db, storeCode: string, kind: "INV" | "CN", prefix: string): number {
  const row = db.prepare("SELECT next_no FROM invoice_series WHERE store_code = ? AND kind = ? AND prefix = ?").get(storeCode, kind, prefix) as { next_no: number } | undefined;
  if (!row) throw new Error(`${kind} series for ${storeCode} ${prefix} not initialised`);
  db.prepare("UPDATE invoice_series SET next_no = next_no + 1 WHERE store_code = ? AND kind = ? AND prefix = ?").run(storeCode, kind, prefix);
  return row.next_no;
}
