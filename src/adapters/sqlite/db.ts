import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Only data the POS owns lives here: invoice/credit-note series, bill state (the outbox that survives a
// Wi-Fi drop), till sessions and the audit trail. Customers, products, stock and orders stay in Shopify.

const MIGRATIONS: string[] = [
  // 1: invoice series, bills, audit
  `
  CREATE TABLE invoice_series (
    store_code TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('INV', 'CN')),
    fy         TEXT NOT NULL,
    next_no    INTEGER NOT NULL CHECK (next_no >= 1),
    PRIMARY KEY (store_code, kind, fy)
  );

  CREATE TABLE invoices (
    invoice_no        TEXT PRIMARY KEY,
    store_code        TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('INV', 'CN')),
    seq_no            INTEGER NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('NUMBERED', 'CHARGED', 'CHARGED_NOT_POSTED', 'POSTED', 'CANCELLED')),
    payload_json      TEXT NOT NULL,
    charge_id         TEXT,
    shopify_order_id  INTEGER,
    sale_tx_id        INTEGER,
    parent_invoice_no TEXT REFERENCES invoices(invoice_no),
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX invoices_store_status ON invoices (store_code, status);

  CREATE TABLE audit_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          TEXT NOT NULL,
    staff_id    TEXT,
    action      TEXT NOT NULL,
    ref         TEXT,
    reason_code TEXT,
    approver_id TEXT,
    payload_json TEXT
  );
  CREATE INDEX audit_ref ON audit_events (ref);
  `,
  // 2: cash till
  `
  CREATE TABLE till_sessions (
    session_id     TEXT PRIMARY KEY,
    location_id    INTEGER NOT NULL,
    store_code     TEXT NOT NULL,
    opened_by      TEXT NOT NULL,
    opened_at      TEXT NOT NULL,
    float_paise    INTEGER NOT NULL CHECK (float_paise >= 0),
    closed_by      TEXT,
    closed_at      TEXT,
    counted_paise  INTEGER,
    expected_paise INTEGER,
    variance_paise INTEGER
  );
  CREATE UNIQUE INDEX till_one_open_per_store ON till_sessions (store_code) WHERE closed_at IS NULL;

  CREATE TABLE till_movements (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES till_sessions(session_id),
    type         TEXT NOT NULL CHECK (type IN ('cash_sale', 'cash_refund', 'paid_in', 'paid_out')),
    amount_paise INTEGER NOT NULL,
    ref          TEXT,
    reason       TEXT,
    staff_id     TEXT NOT NULL,
    at           TEXT NOT NULL
  );
  `,
  // 3: carts in progress
  `
  CREATE TABLE carts (
    cart_id    TEXT PRIMARY KEY,
    store_code TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('open', 'checked_out')),
    cart_json  TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // 4: series keyed by the store's invoice prefix (it carries the FY); one live bill per cart
  `
  ALTER TABLE invoice_series RENAME COLUMN fy TO prefix;
  ALTER TABLE invoices ADD COLUMN cart_id TEXT;
  CREATE UNIQUE INDEX invoices_one_live_bill_per_cart ON invoices (cart_id) WHERE cart_id IS NOT NULL AND status <> 'CANCELLED';
  `,
  // 5: credit notes (refunds); one live full refund per invoice
  `
  CREATE TABLE credit_notes (
    credit_note_no TEXT PRIMARY KEY,
    store_code     TEXT NOT NULL,
    seq_no         INTEGER NOT NULL,
    invoice_no     TEXT NOT NULL REFERENCES invoices(invoice_no),
    scope          TEXT NOT NULL CHECK (scope IN ('full', 'partial')),
    status         TEXT NOT NULL CHECK (status IN ('NUMBERED', 'REFUNDED', 'REFUNDED_NOT_POSTED', 'POSTED', 'CANCELLED')),
    payload_json   TEXT NOT NULL,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE UNIQUE INDEX credit_notes_one_live_full_refund ON credit_notes (invoice_no) WHERE scope = 'full' AND status <> 'CANCELLED';
  `,
];

export type Db = Database.Database;

export function openDb(file: string): Db {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]!);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}
