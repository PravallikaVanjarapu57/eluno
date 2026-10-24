import type { Bill, BillStatus } from "../../domain/bill.js";
import { formatInvoiceNo } from "../../domain/bill.js";
import type { BillRepository } from "../../ports/index.js";
import type { Db } from "./db.js";
import { hasSeries, initSeries, takeNext } from "./series.js";

export class SqliteBillRepository implements BillRepository {
  constructor(private readonly db: Db) {}

  hasSeries(storeCode: string, kind: "INV" | "CN", prefix: string): boolean {
    return hasSeries(this.db, storeCode, kind, prefix);
  }

  initSeries(storeCode: string, kind: "INV" | "CN", prefix: string, nextNo: number): void {
    initSeries(this.db, storeCode, kind, prefix, nextNo);
  }

  /**
   * Takes the next number and stores the bill in one transaction: a number is never handed out without a
   * row that accounts for it, so the series has no gaps (a failed bill is CANCELLED, not deleted).
   */
  createNumbered(storeCode: string, prefix: string, build: (invoiceNo: string, seq: number) => Bill): Bill {
    return this.db.transaction(() => {
      const seq = takeNext(this.db, storeCode, "INV", prefix);
      const bill = build(formatInvoiceNo(prefix, seq), seq);
      this.db
        .prepare(
          `INSERT INTO invoices (invoice_no, store_code, kind, seq_no, status, payload_json, cart_id, created_at, updated_at)
           VALUES (?, ?, 'INV', ?, ?, ?, ?, ?, ?)`,
        )
        .run(bill.invoiceNo, storeCode, seq, bill.status, JSON.stringify(bill), bill.cartId, bill.createdAt, bill.createdAt);
      return bill;
    })();
  }

  get(invoiceNo: string): Bill | null {
    const row = this.db.prepare("SELECT payload_json FROM invoices WHERE invoice_no = ? AND kind = 'INV'").get(invoiceNo) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as Bill) : null;
  }

  liveForCart(cartId: string): Bill | null {
    const row = this.db.prepare("SELECT payload_json FROM invoices WHERE cart_id = ? AND status <> 'CANCELLED'").get(cartId) as { payload_json: string } | undefined;
    return row ? (JSON.parse(row.payload_json) as Bill) : null;
  }

  save(bill: Bill, at: string): void {
    this.db
      .prepare(
        `UPDATE invoices SET status = ?, payload_json = ?, charge_id = ?, shopify_order_id = ?, updated_at = ? WHERE invoice_no = ?`,
      )
      .run(bill.status, JSON.stringify(bill), bill.payment?.chargeId ?? null, bill.posted ? Number(bill.posted.orderRef) : null, at, bill.invoiceNo);
  }

  listByStatus(statuses: readonly BillStatus[]): Bill[] {
    const rows = this.db
      .prepare(`SELECT payload_json FROM invoices WHERE kind = 'INV' AND status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at`)
      .all(...statuses) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as Bill);
  }

  listForStore(storeCode: string): Bill[] {
    const rows = this.db.prepare("SELECT payload_json FROM invoices WHERE kind = 'INV' AND store_code = ? ORDER BY seq_no").all(storeCode) as { payload_json: string }[];
    return rows.map((r) => JSON.parse(r.payload_json) as Bill);
  }
}
