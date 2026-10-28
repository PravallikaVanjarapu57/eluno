// What the application needs from the outside world. Adapters implement these; domain and application
// code never see Shopify, store-tool or terminal shapes.

import type { Bill, BillStatus, PostedOrder } from "../domain/bill.js";
import type { Cart } from "../domain/cart.js";
import type { Paise } from "../domain/money.js";
import type { CreditNote, CreditNoteStatus } from "../domain/refund.js";
import type { LedgerOrder } from "../domain/dayEnd.js";
import type { CatalogItem, FrameItem, LensItem } from "../domain/catalog.js";
import type { Customer } from "../domain/customer.js";
import type { Prescription } from "../domain/prescription.js";
import type { Staff, Store } from "../domain/store.js";

export interface CustomerDirectory {
  /** All customers whose phone matches exactly (E.164). */
  findByPhone(phone: string): Promise<Customer[]>;
}

export interface PrescriptionSource {
  listByPhone(phone: string): Promise<Prescription[]>;
}

export interface Catalog {
  getItem(variantId: string): Promise<CatalogItem | null>;
  listLenses(): Promise<LensItem[]>;
}

export interface StockLevels {
  /** Units available at the store; 0 when the store does not stock it. */
  available(frame: FrameItem, store: Store): Promise<number>;
}

export interface StoreDirectory {
  getStore(code: string): Promise<Store | null>;
}

export interface StaffDirectory {
  listByStore(storeCode: string): Promise<Staff[]>;
}

export interface CartRepository {
  get(id: string): Cart | null;
  save(cart: Cart): void;
}

export interface Clock {
  now(): Date;
  /** Business date in the store's time zone, YYYY-MM-DD. */
  today(): string;
}

export interface AuditEvent {
  at: string;
  staffId: string;
  action: string;
  ref: string;
  reasonCode?: string;
  approverId?: string;
  payload?: Record<string, unknown>;
}

export interface AuditLog {
  record(event: AuditEvent): void;
  forRef(ref: string): AuditEvent[];
}

export interface BillRepository {
  hasSeries(storeCode: string, kind: "INV" | "CN", prefix: string): boolean;
  initSeries(storeCode: string, kind: "INV" | "CN", prefix: string, nextNo: number): void;
  createNumbered(storeCode: string, prefix: string, build: (invoiceNo: string, seq: number) => Bill): Bill;
  get(invoiceNo: string): Bill | null;
  liveForCart(cartId: string): Bill | null;
  save(bill: Bill, at: string): void;
  listByStatus(statuses: readonly BillStatus[]): Bill[];
  listForStore(storeCode: string): Bill[];
}

export type ChargeResult =
  | { outcome: "captured"; chargeId: string }
  | { outcome: "declined"; reason: string }
  /** No definite answer (timeout, retries used up). Retrying with the same orderRef is safe. */
  | { outcome: "unknown"; reason: string };

export type RefundResult =
  | { outcome: "refunded"; refundRef: string | null }
  | { outcome: "rejected"; reason: string }
  | { outcome: "unknown"; reason: string };

export interface PaymentTerminal {
  charge(req: { orderRef: string; amountPaise: Paise; method: "upi" | "card" }): Promise<ChargeResult>;
  /** Refund against a captured charge. Safe to call again: it checks what was already refunded first. */
  refund(req: { chargeId: string; amountPaise: Paise; reason: string }): Promise<RefundResult>;
}

export interface OrderSink {
  /** Throws OrderOutcomeUnknown when the write may or may not have happened. */
  createOrder(bill: Bill): Promise<PostedOrder>;
  findOrderByInvoiceNo(bill: Bill): Promise<PostedOrder | null>;
  /** Highest invoice sequence already used in the system of record for this prefix (0 if none). */
  maxInvoiceSeq(store: Store, prefix: string): Promise<number>;
  /** Highest credit-note sequence already used for this prefix (0 if none). */
  maxCreditNoteSeq(store: Store, prefix: string): Promise<number>;
  /** What the system of record would refund per line; used to cross-check before money moves. */
  calculateRefund(cn: CreditNote): Promise<{ lineRef: string; amountPaise: Paise; taxPaise: Paise }[]>;
  /** Throws OrderOutcomeUnknown / OrderRejected like createOrder. */
  createRefund(cn: CreditNote): Promise<{ refundRef: string }>;
  findRefund(cn: CreditNote): Promise<{ refundRef: string } | null>;
}

export interface CreditNoteRepository {
  hasSeries(storeCode: string, prefix: string): boolean;
  initSeries(storeCode: string, prefix: string, nextNo: number): void;
  createNumbered(storeCode: string, prefix: string, build: (creditNoteNo: string) => CreditNote): CreditNote;
  get(creditNoteNo: string): CreditNote | null;
  liveForInvoice(invoiceNo: string): CreditNote | null;
  listForInvoice(invoiceNo: string): CreditNote[];
  save(cn: CreditNote, at: string): void;
  listByStatus(statuses: readonly CreditNoteStatus[]): CreditNote[];
  listForStore(storeCode: string): CreditNote[];
}

/** The write may have happened; look before writing again. */
export class OrderOutcomeUnknown extends Error { }
/** The system of record refused the order; retrying unchanged will not help. */
export class OrderRejected extends Error { }

export interface SalesLedger {
  /** The store's orders created on or after `sinceDate` (IST), with their refunds. */
  ordersSince(store: Store, sinceDate: string): Promise<LedgerOrder[]>;
}
