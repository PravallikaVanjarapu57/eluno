import { DomainError } from "../domain/errors.js";
import type { ReasonCode } from "../domain/offers/offer.js";
import { creditNotePrefix, planFullRefund, type CreditNote } from "../domain/refund.js";
import {
  OrderOutcomeUnknown,
  OrderRejected,
  type AuditLog,
  type BillRepository,
  type Clock,
  type CreditNoteRepository,
  type OrderSink,
  type PaymentTerminal,
  type StaffDirectory,
  type StoreDirectory,
} from "../ports/index.js";

export interface RefundDeps {
  bills: BillRepository;
  creditNotes: CreditNoteRepository;
  stores: StoreDirectory;
  staff: StaffDirectory;
  terminal: PaymentTerminal;
  orders: OrderSink;
  audit: AuditLog;
  clock: Clock;
  refundReasons: readonly ReasonCode[];
  postAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FullRefundInput {
  staffId: string;
  reasonCode: string;
  note?: string;
}

/**
 * Full refund: credit note number -> Shopify agrees on the amounts -> money back -> refund in Shopify
 * (tax reversed per line, frame restocked at the billing store, lens not restocked, refund against the sale).
 * Same resume rules as checkout: every step saved first, look before re-writing, never pay out twice.
 */
export class Refunds {
  private readonly postAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inflight = new Map<string, Promise<CreditNote>>();

  constructor(private readonly d: RefundDeps) {
    this.postAttempts = d.postAttempts ?? 3;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get(creditNoteNo: string): CreditNote {
    const cn = this.d.creditNotes.get(creditNoteNo);
    if (!cn) throw new DomainError("CREDIT_NOTE_NOT_FOUND", `No credit note ${creditNoteNo}.`, { creditNoteNo });
    return cn;
  }

  forInvoice(invoiceNo: string): CreditNote[] {
    return this.d.creditNotes.listForInvoice(invoiceNo);
  }

  async refundInFull(invoiceNo: string, input: FullRefundInput): Promise<CreditNote> {
    // Asking twice (or a client retry) resumes the same credit note.
    const existing = this.d.creditNotes.liveForInvoice(invoiceNo);
    if (existing) return this.drive(existing);

    const bill = this.d.bills.get(invoiceNo);
    if (!bill) throw new DomainError("BILL_NOT_FOUND", `No bill ${invoiceNo}.`, { invoiceNo });
    if (!this.d.refundReasons.some((r) => r.code === input.reasonCode)) {
      throw new DomainError("REFUND_NOT_ALLOWED", `Unknown refund reason "${input.reasonCode}". Pick one of: ${this.d.refundReasons.map((r) => r.code).join(", ")}.`);
    }
    const roster = await this.d.staff.listByStore(bill.store.code);
    if (!roster.some((s) => s.staffId === input.staffId)) {
      throw new DomainError("STAFF_NOT_AT_STORE", `Staff ${input.staffId} is not on the ${bill.store.code} roster.`, { staffId: input.staffId });
    }
    const store = await this.d.stores.getStore(bill.store.code);
    if (!store) throw new DomainError("STORE_NOT_FOUND", `${bill.store.code} is not a store.`);

    const prefix = creditNotePrefix(store.invoicePrefix);
    if (!this.d.creditNotes.hasSeries(store.code, prefix)) {
      this.d.creditNotes.initSeries(store.code, prefix, (await this.d.orders.maxCreditNoteSeq(store, prefix)) + 1);
    }

    const now = this.d.clock.now().toISOString();
    // Validate before taking a number, so a refused refund does not leave a cancelled credit note behind.
    planFullRefund({ bill, creditNoteNo: "PENDING", staffId: input.staffId, reasonCode: input.reasonCode, note: input.note ?? null, now });
    let cn: CreditNote;
    try {
      cn = this.d.creditNotes.createNumbered(store.code, prefix, (creditNoteNo) =>
        planFullRefund({ bill, creditNoteNo, staffId: input.staffId, reasonCode: input.reasonCode, note: input.note ?? null, now }),
      );
    } catch (e) {
      const raced = this.d.creditNotes.liveForInvoice(invoiceNo);
      if (raced) return this.drive(raced);
      throw e;
    }
    this.audit(cn, "refund.numbered", { amountPaise: cn.totals.amountPaise });
    return this.drive(cn);
  }

  async resume(creditNoteNo: string): Promise<CreditNote> {
    return this.drive(this.get(creditNoteNo));
  }

  /** Recovery sweep: refunds where the money went back but Shopify has not recorded it yet. */
  async resumePending(): Promise<CreditNote[]> {
    const out: CreditNote[] = [];
    for (const cn of this.d.creditNotes.listByStatus(["REFUNDED", "REFUNDED_NOT_POSTED"])) out.push(await this.drive(cn));
    return out;
  }

  private drive(cn: CreditNote): Promise<CreditNote> {
    const running = this.inflight.get(cn.creditNoteNo);
    if (running) return running;
    const run = this.step(cn).finally(() => this.inflight.delete(cn.creditNoteNo));
    this.inflight.set(cn.creditNoteNo, run);
    return run;
  }

  private async step(cn: CreditNote): Promise<CreditNote> {
    cn = this.d.creditNotes.get(cn.creditNoteNo) ?? cn;
    if (cn.status === "NUMBERED") cn = await this.moneyBack(cn);
    if (cn.status === "REFUNDED" || cn.status === "REFUNDED_NOT_POSTED") cn = await this.post(cn);
    return cn;
  }

  private async moneyBack(cn: CreditNote): Promise<CreditNote> {
    if (!cn.checked) {
      // Cross-check with Shopify before any money moves: if we disagree on the amounts, stop here.
      let theirs;
      try {
        theirs = await this.d.orders.calculateRefund(cn);
      } catch (e) {
        return this.update(cn, { lastError: `Could not reach Shopify to check the refund: ${(e as Error).message}` }, "refund.check_failed");
      }
      const mismatch = cn.lines.find((l) => {
        const t = theirs.find((x) => x.lineRef === l.lineRef);
        return !t || t.amountPaise !== l.amountPaise || t.taxPaise !== l.cgstPaise + l.sgstPaise;
      });
      if (mismatch) {
        return this.update(cn, { status: "CANCELLED", cancelReason: `Shopify's refund amounts differ from the invoice on ${mismatch.sku}; not refunded. Tell the tech team.` }, "refund.mismatch");
      }
      cn = this.update(cn, { checked: true, lastError: null }, "refund.checked");
    }

    const at = this.d.clock.now().toISOString();
    if (cn.refundMethod === "cash" || !cn.source.chargeId) {
      // Cash comes out of the drawer (recorded against the till session).
      return this.update(cn, { status: "REFUNDED", moneyBack: { refundRef: null, at }, lastError: null }, "refund.money_back", { method: "cash" });
    }
    const r = await this.d.terminal.refund({ chargeId: cn.source.chargeId, amountPaise: cn.totals.amountPaise, reason: cn.reasonCode });
    switch (r.outcome) {
      case "refunded":
        return this.update(cn, { status: "REFUNDED", moneyBack: { refundRef: r.refundRef, at }, lastError: null }, "refund.money_back", { refundRef: r.refundRef });
      case "rejected":
        return this.update(cn, { status: "CANCELLED", cancelReason: r.reason }, "refund.cancelled");
      case "unknown":
        return this.update(cn, { lastError: `Refund status unknown: ${r.reason}` }, "refund.money_back_unknown");
    }
  }

  private async post(cn: CreditNote): Promise<CreditNote> {
    for (let attempt = 1; attempt <= this.postAttempts; attempt++) {
      try {
        const found = cn.lastError ? await this.d.orders.findRefund(cn) : null;
        const posted = found ?? (await this.d.orders.createRefund(cn));
        return this.update(cn, { status: "POSTED", posted, lastError: null }, "refund.posted", { refundRef: posted.refundRef, adopted: !!found });
      } catch (e) {
        if (e instanceof OrderRejected) return this.update(cn, { status: "REFUNDED_NOT_POSTED", lastError: e.message }, "refund.post_rejected");
        const msg = e instanceof OrderOutcomeUnknown ? e.message : `Shopify unreachable: ${(e as Error).message}`;
        cn = this.update(cn, { status: "REFUNDED_NOT_POSTED", lastError: msg }, "refund.post_failed", { attempt });
        if (attempt < this.postAttempts) await this.sleep(500 * attempt);
      }
    }
    return cn;
  }

  private update(cn: CreditNote, patch: Partial<CreditNote>, action: string, payload: Record<string, unknown> = {}): CreditNote {
    const next = { ...cn, ...patch };
    this.d.creditNotes.save(next, this.d.clock.now().toISOString());
    this.audit(next, action, { ...payload, ...(patch.lastError ? { error: patch.lastError } : {}), ...(patch.cancelReason ? { reason: patch.cancelReason } : {}) });
    return next;
  }

  private audit(cn: CreditNote, action: string, payload: Record<string, unknown>): void {
    this.d.audit.record({
      at: this.d.clock.now().toISOString(),
      staffId: cn.staffId,
      action,
      ref: cn.creditNoteNo,
      reasonCode: cn.reasonCode,
      payload: { invoiceNo: cn.invoiceNo, status: cn.status, ...payload },
    });
  }
}
