import { beforeEach, describe, expect, it } from "vitest";
import { Refunds } from "../../src/application/refunds.js";
import { openDb, type Db } from "../../src/adapters/sqlite/db.js";
import { SqliteBillRepository } from "../../src/adapters/sqlite/billRepo.js";
import { SqliteCreditNoteRepository } from "../../src/adapters/sqlite/creditNoteRepo.js";
import { SqliteAuditLog } from "../../src/adapters/sqlite/auditLog.js";
import { loadPosConfig } from "../../src/config/load.js";
import type { Bill } from "../../src/domain/bill.js";
import type { CreditNote } from "../../src/domain/refund.js";
import { OrderOutcomeUnknown, OrderRejected, type OrderSink, type PaymentTerminal, type RefundResult } from "../../src/ports/index.js";
import { HSR, postedBill } from "../support/bills.js";

const cfg = loadPosConfig("config");

class FakeShopify implements OrderSink {
  refunds: CreditNote[] = [];
  creates = 0;
  script: ("ok" | "write-then-timeout" | "timeout" | "reject")[] = [];
  calc: "agree" | "disagree" | "down" = "agree";
  async createOrder(): Promise<never> { throw new Error("unused"); }
  async findOrderByInvoiceNo() { return null; }
  async maxInvoiceSeq() { return 0; }
  async maxCreditNoteSeq() { return 2; } // seed: ELU/HSR/FY26/CN/00002 exists
  async calculateRefund(cn: CreditNote) {
    if (this.calc === "down") throw new Error("ECONNRESET");
    return cn.lines.map((l) => ({ lineRef: l.lineRef, amountPaise: l.amountPaise + (this.calc === "disagree" ? 1 : 0), taxPaise: l.cgstPaise + l.sgstPaise }));
  }
  async createRefund(cn: CreditNote) {
    this.creates++;
    const step = this.script.shift() ?? "ok";
    if (step === "timeout") throw new OrderOutcomeUnknown("timeout before write");
    if (step === "reject") throw new OrderRejected("Shopify refused the refund");
    this.refunds.push(cn);
    if (step === "write-then-timeout") throw new OrderOutcomeUnknown("timeout after write");
    return { refundRef: `rf_${this.refunds.length}` };
  }
  async findRefund(cn: CreditNote) {
    const i = this.refunds.findIndex((r) => r.creditNoteNo === cn.creditNoteNo);
    return i >= 0 ? { refundRef: `rf_${i + 1}` } : null;
  }
}

/** Pays out at most once per charge, like the real terminal's refundable-amount check. */
class FakeTerminal implements PaymentTerminal {
  payouts: number[] = [];
  script: RefundResult["outcome"][] = [];
  async charge(): Promise<never> { throw new Error("unused"); }
  async refund(req: { amountPaise: number }): Promise<RefundResult> {
    const step = this.script.shift();
    if (step === "rejected") return { outcome: "rejected", reason: "charge is older than 180 days" };
    if (this.payouts.length > 0) return { outcome: "refunded", refundRef: null }; // already refunded: no second payout
    this.payouts.push(req.amountPaise);
    if (step === "unknown") return { outcome: "unknown", reason: "terminal timeout" }; // paid out, answer lost
    return { outcome: "refunded", refundRef: "trf_1" };
  }
}

let db: Db;
let shopify: FakeShopify;
let terminal: FakeTerminal;
let refunds: Refunds;
let audit: SqliteAuditLog;

function seedBill(bill: Bill) {
  db.prepare("INSERT INTO invoices (invoice_no, store_code, kind, seq_no, status, payload_json, cart_id, created_at, updated_at) VALUES (?, 'HSR', 'INV', 3, ?, ?, ?, ?, ?)")
    .run(bill.invoiceNo, bill.status, JSON.stringify(bill), bill.cartId, bill.createdAt, bill.createdAt);
  return bill.invoiceNo;
}

beforeEach(() => {
  db = openDb(":memory:");
  shopify = new FakeShopify();
  terminal = new FakeTerminal();
  audit = new SqliteAuditLog(db);
  refunds = new Refunds({
    bills: new SqliteBillRepository(db),
    creditNotes: new SqliteCreditNoteRepository(db),
    stores: { getStore: async () => HSR },
    staff: { listByStore: async () => [{ staffId: "S105", name: "A", role: "sales", storeCode: "HSR", badges: [], canOverrideDiscount: false }] },
    terminal, orders: shopify, audit,
    clock: { now: () => new Date("2026-10-24T05:00:00Z"), today: () => "2026-10-24" },
    refundReasons: cfg.reasonCodes.refund,
    sleep: async () => {},
  });
});

const ask = { staffId: "S105", reasonCode: "CHANGED_MIND" };

describe("Refunds", () => {
  it("full refund: credit note continues the store's series, money back once, refund recorded once", async () => {
    const cn = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(cn).toMatchObject({ creditNoteNo: "ELU/HSR/FY26/CN/00003", status: "POSTED", checked: true, posted: { refundRef: "rf_1" }, moneyBack: { refundRef: "trf_1" } });
    expect(terminal.payouts).toEqual([1869700]);
    expect(shopify.refunds).toHaveLength(1);
    expect(audit.forRef(cn.creditNoteNo).map((e) => e.action)).toEqual(["refund.numbered", "refund.checked", "refund.money_back", "refund.posted"]);
    expect(audit.forRef(cn.creditNoteNo).every((e) => e.reasonCode === "CHANGED_MIND")).toBe(true);
  });

  it("asking again returns the same credit note, never a second refund", async () => {
    const no = seedBill(postedBill());
    const [a, b] = await Promise.all([refunds.refundInFull(no, ask), refunds.refundInFull(no, ask)]);
    const c = await refunds.refundInFull(no, ask);
    expect(new Set([a.creditNoteNo, b.creditNoteNo, c.creditNoteNo]).size).toBe(1);
    expect(terminal.payouts).toHaveLength(1);
    expect(shopify.refunds).toHaveLength(1);
  });

  it("if Shopify's numbers disagree with the invoice, no money moves", async () => {
    shopify.calc = "disagree";
    const cn = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(cn).toMatchObject({ status: "CANCELLED", cancelReason: expect.stringMatching(/differ from the invoice/) });
    expect(terminal.payouts).toEqual([]);
  });

  it("if the check cannot reach Shopify, it waits; resume runs the check before paying", async () => {
    shopify.calc = "down";
    const first = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(first).toMatchObject({ status: "NUMBERED", checked: false });
    expect(terminal.payouts).toEqual([]);
    shopify.calc = "disagree";
    expect((await refunds.resume(first.creditNoteNo)).status).toBe("CANCELLED"); // the check was not skipped
  });

  it("terminal answer lost after paying out: resume does not pay again", async () => {
    terminal.script = ["unknown"];
    const first = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(first).toMatchObject({ status: "NUMBERED", lastError: expect.stringMatching(/Refund status unknown/) });
    const done = await refunds.resume(first.creditNoteNo);
    expect(done.status).toBe("POSTED");
    expect(terminal.payouts).toEqual([1869700]);
  });

  it("terminal refuses: credit note cancelled (kept in the series), nothing recorded in Shopify", async () => {
    terminal.script = ["rejected"];
    const cn = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(cn).toMatchObject({ status: "CANCELLED", cancelReason: expect.stringMatching(/180 days/) });
    expect(shopify.creates).toBe(0);
  });

  it("Shopify recorded the refund but the response was lost: found, not duplicated", async () => {
    shopify.script = ["write-then-timeout"];
    const cn = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(cn.status).toBe("POSTED");
    expect(shopify.refunds).toHaveLength(1);
  });

  it("Shopify down after the money went back: kept as refunded-not-posted, the sweep finishes it once", async () => {
    shopify.script = ["timeout", "timeout", "timeout"];
    const cn = await refunds.refundInFull(seedBill(postedBill()), ask);
    expect(cn.status).toBe("REFUNDED_NOT_POSTED");
    const [done] = await refunds.resumePending();
    expect(done!.status).toBe("POSTED");
    expect(shopify.refunds).toHaveLength(1);
    expect(terminal.payouts).toHaveLength(1);
  });

  it("cash: money from the drawer, no terminal call", async () => {
    const cn = await refunds.refundInFull(seedBill(postedBill({ payment: { method: "cash", amountPaise: 1869700, chargeId: null, at: "x" } })), ask);
    expect(cn).toMatchObject({ status: "POSTED", refundMethod: "cash" });
    expect(terminal.payouts).toEqual([]);
  });

  it("bad requests are refused before a credit note number is used", async () => {
    const no = seedBill(postedBill());
    await expect(refunds.refundInFull(no, { staffId: "S105", reasonCode: "BORED" })).rejects.toMatchObject({ code: "REFUND_NOT_ALLOWED", message: expect.stringMatching(/Pick one of: CHANGED_MIND/) });
    await expect(refunds.refundInFull(no, { staffId: "S999", reasonCode: "CHANGED_MIND" })).rejects.toMatchObject({ code: "STAFF_NOT_AT_STORE" });
    await expect(refunds.refundInFull("ELU/HSR/FY26/09999", ask)).rejects.toMatchObject({ code: "BILL_NOT_FOUND" });
    const pending = seedBill(postedBill({ invoiceNo: "ELU/HSR/FY26/00004", cartId: "cart-2", status: "CHARGED_NOT_POSTED", posted: null }));
    await expect(refunds.refundInFull(pending, ask)).rejects.toMatchObject({ code: "REFUND_NOT_ALLOWED" });
    expect((await refunds.refundInFull(no, ask)).creditNoteNo).toBe("ELU/HSR/FY26/CN/00003");
  });
});
