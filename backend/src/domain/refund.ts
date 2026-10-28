import type { Bill, PaymentMethod } from "./bill.js";
import { DomainError } from "./errors.js";
import type { Paise } from "./money.js";

// A credit note reverses an invoice. It mirrors the invoice line by line (taxable value, CGST, SGST as
// billed), so a later rate change can never make the credit note disagree with the invoice it cancels.
//
//   NUMBERED ── money returned ──▶ REFUNDED ── refund recorded in Shopify ──▶ POSTED
//      │                              └── posting failed ──▶ REFUNDED_NOT_POSTED ── resume ──▶ POSTED
//      └── refund refused / Shopify disagrees ──▶ CANCELLED (number stays in the series)

export type CreditNoteStatus = "NUMBERED" | "REFUNDED" | "REFUNDED_NOT_POSTED" | "POSTED" | "CANCELLED";

export interface CreditNoteLine {
  lineId: string;
  /** The system of record's id for the invoice line being reversed. */
  lineRef: string;
  kind: "frame" | "lens";
  sku: string;
  hsn: string;
  rateBps: number;
  amountPaise: Paise; // what the customer paid for the line
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  /** Frames go back on the shelf of the store that sold them; made-to-order lenses are scrapped. */
  restock: { type: "return"; locationRef: string } | { type: "no_restock" };
}

export interface CreditNote {
  creditNoteNo: string;
  invoiceNo: string;
  status: CreditNoteStatus;
  scope: "full";
  store: Bill["store"];
  customer: Bill["customer"];
  staffId: string;
  reasonCode: string;
  note: string | null;
  createdAt: string;
  lines: CreditNoteLine[];
  totals: { amountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise };
  refundMethod: PaymentMethod;
  /** Where the money goes back to. */
  source: { orderRef: string; saleTransactionRef: string | null; chargeId: string | null };
  /** Shopify's refund calculation agreed with these lines; money may move only after this. */
  checked: boolean;
  moneyBack: { refundRef: string | null; at: string } | null;
  posted: { refundRef: string } | null;
  lastError: string | null;
  cancelReason: string | null;
}

export function planFullRefund(args: {
  bill: Bill;
  creditNoteNo: string;
  staffId: string;
  reasonCode: string;
  note: string | null;
  now: string;
}): CreditNote {
  const { bill } = args;
  if (bill.status !== "POSTED" || !bill.posted) {
    throw new DomainError(
      "REFUND_NOT_ALLOWED",
      bill.status === "CANCELLED"
        ? `${bill.invoiceNo} was cancelled; there is nothing to refund.`
        : `${bill.invoiceNo} is ${bill.status}; it must be confirmed in Shopify before it can be refunded. Resume the bill first.`,
      { status: bill.status },
    );
  }
  if (!bill.payment || bill.payment.amountPaise === 0) {
    throw new DomainError("REFUND_NOT_ALLOWED", `${bill.invoiceNo} was a zero-value bill; there is no money to refund.`);
  }
  const posted = bill.posted;
  const lines: CreditNoteLine[] = bill.lines.map((l) => {
    const lineRef = posted.lineRefs[l.lineId];
    if (!lineRef) throw new DomainError("REFUND_NOT_ALLOWED", `Line ${l.lineId} of ${bill.invoiceNo} has no Shopify line id; cannot refund it.`);
    return {
      lineId: l.lineId,
      lineRef,
      kind: l.kind,
      sku: l.sku,
      hsn: l.hsn,
      rateBps: l.rateBps,
      amountPaise: l.netPaise,
      taxablePaise: l.taxablePaise,
      cgstPaise: l.cgstPaise,
      sgstPaise: l.sgstPaise,
      restock: l.kind === "frame" ? { type: "return", locationRef: bill.store.locationRef } : { type: "no_restock" },
    };
  });
  const sum = (f: (l: CreditNoteLine) => Paise) => lines.reduce((a, l) => a + f(l), 0);
  const amountPaise = sum((l) => l.amountPaise);
  if (amountPaise !== bill.payment.amountPaise) {
    throw new DomainError("REFUND_NOT_ALLOWED", `Lines of ${bill.invoiceNo} add up to ${amountPaise} paise but ${bill.payment.amountPaise} was collected.`);
  }
  return {
    creditNoteNo: args.creditNoteNo,
    invoiceNo: bill.invoiceNo,
    status: "NUMBERED",
    scope: "full",
    store: bill.store,
    customer: bill.customer,
    staffId: args.staffId,
    reasonCode: args.reasonCode,
    note: args.note,
    createdAt: args.now,
    lines,
    totals: { amountPaise, taxablePaise: sum((l) => l.taxablePaise), cgstPaise: sum((l) => l.cgstPaise), sgstPaise: sum((l) => l.sgstPaise) },
    refundMethod: bill.payment.method,
    source: { orderRef: posted.orderRef, saleTransactionRef: posted.saleTransactionRef, chargeId: bill.payment.chargeId },
    checked: false,
    moneyBack: null,
    posted: null,
    lastError: null,
    cancelReason: null,
  };
}

/** Credit notes use the store's invoice prefix plus "CN/": ELU/HSR/FY26/CN/00001. */
export function creditNotePrefix(invoicePrefix: string): string {
  return `${invoicePrefix}CN/`;
}
