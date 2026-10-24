import { formatInvoiceNo } from "../../domain/bill.js";
import type { CreditNote, CreditNoteStatus } from "../../domain/refund.js";
import type { CreditNoteRepository } from "../../ports/index.js";
import type { Db } from "./db.js";
import { hasSeries, initSeries, takeNext } from "./series.js";

export class SqliteCreditNoteRepository implements CreditNoteRepository {
  constructor(private readonly db: Db) {}

  hasSeries(storeCode: string, prefix: string): boolean {
    return hasSeries(this.db, storeCode, "CN", prefix);
  }

  initSeries(storeCode: string, prefix: string, nextNo: number): void {
    initSeries(this.db, storeCode, "CN", prefix, nextNo);
  }

  createNumbered(storeCode: string, prefix: string, build: (creditNoteNo: string) => CreditNote): CreditNote {
    return this.db.transaction(() => {
      const seq = takeNext(this.db, storeCode, "CN", prefix);
      const cn = build(formatInvoiceNo(prefix, seq));
      this.db
        .prepare(
          `INSERT INTO credit_notes (credit_note_no, store_code, seq_no, invoice_no, scope, status, payload_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(cn.creditNoteNo, storeCode, seq, cn.invoiceNo, cn.scope, cn.status, JSON.stringify(cn), cn.createdAt, cn.createdAt);
      return cn;
    })();
  }

  get(creditNoteNo: string): CreditNote | null {
    const row = this.db.prepare("SELECT payload_json FROM credit_notes WHERE credit_note_no = ?").get(creditNoteNo) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as CreditNote) : null;
  }

  liveForInvoice(invoiceNo: string): CreditNote | null {
    const row = this.db.prepare("SELECT payload_json FROM credit_notes WHERE invoice_no = ? AND scope = 'full' AND status <> 'CANCELLED'").get(invoiceNo) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as CreditNote) : null;
  }

  listForInvoice(invoiceNo: string): CreditNote[] {
    const rows = this.db.prepare("SELECT payload_json FROM credit_notes WHERE invoice_no = ? ORDER BY seq_no").all(invoiceNo) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as CreditNote);
  }

  save(cn: CreditNote, at: string): void {
    this.db.prepare("UPDATE credit_notes SET status = ?, payload_json = ?, updated_at = ? WHERE credit_note_no = ?").run(cn.status, JSON.stringify(cn), at, cn.creditNoteNo);
  }

  listByStatus(statuses: readonly CreditNoteStatus[]): CreditNote[] {
    const rows = this.db
      .prepare(`SELECT payload_json FROM credit_notes WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...statuses) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as CreditNote);
  }

  listForStore(storeCode: string): CreditNote[] {
    const rows = this.db.prepare("SELECT payload_json FROM credit_notes WHERE store_code = ? ORDER BY seq_no").all(storeCode) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as CreditNote);
  }
}
