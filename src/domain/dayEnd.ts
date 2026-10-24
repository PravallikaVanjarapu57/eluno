import type { Bill, PaymentMethod } from "./bill.js";
import type { Paise } from "./money.js";
import type { CreditNote } from "./refund.js";

// Day-end for one store and one business date (IST).
//
// Source of truth: the system of record (Shopify), because that is what finance reconciles against.
// The till's own ledger is laid alongside, and every disagreement is listed rather than silently resolved.
// Sales count on the day the order was created; refunds count on the day the refund was made, whichever
// day the original bill was (that is how the credit note is dated).

export interface LedgerRefund {
  refundRef: string;
  creditNoteNo: string | null;
  createdAt: string;
  amountPaise: Paise;
  taxPaise: Paise;
}

export interface LedgerOrder {
  orderRef: string;
  orderName: string;
  invoiceNo: string | null;
  createdAt: string;
  channel: string | null;
  paymentMethod: PaymentMethod | null;
  cancelled: boolean;
  grossPaise: Paise; // MRP, before discounts
  discountPaise: Paise;
  taxPaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  netPaise: Paise; // charged
  discounts: { code: string; amountPaise: Paise }[];
  salePaise: Paise; // successful sale transactions
  refunds: LedgerRefund[];
}

export type MismatchKind =
  | "MISSING_IN_SHOPIFY" // the till says posted, Shopify has no such order that day
  | "NOT_POSTED" // paid (or maybe paid) at the till, not yet in Shopify
  | "AMOUNT_DIFFERS"
  | "NOT_FROM_THIS_TILL" // in Shopify for this store and day, unknown to this till (old POS, manual entry)
  | "REFUND_NOT_POSTED"
  | "PAYMENT_NOT_CAPTURED"; // order total and captured sale amount differ

export interface Mismatch {
  kind: MismatchKind;
  /** error: the day does not reconcile until it is fixed. info: worth knowing, not a discrepancy in money. */
  severity: "error" | "info";
  ref: string;
  detail: string;
}

const SEVERITY: Record<MismatchKind, Mismatch["severity"]> = {
  MISSING_IN_SHOPIFY: "error",
  NOT_POSTED: "error",
  AMOUNT_DIFFERS: "error",
  NOT_FROM_THIS_TILL: "info",
  REFUND_NOT_POSTED: "error",
  PAYMENT_NOT_CAPTURED: "error",
};

interface Totals {
  bills: number;
  grossPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  taxPaise: Paise;
  netSalesPaise: Paise;
}

export interface DayEndReport {
  storeCode: string;
  date: string;
  source: "shopify";
  sales: Totals & { zeroValueBills: number; cancelledBills: number; averageBillPaise: Paise };
  refunds: { count: number; amountPaise: Paise; taxablePaise: Paise; taxPaise: Paise };
  netAfterRefundsPaise: Paise;
  byPaymentMethod: Record<string, { salesPaise: Paise; refundsPaise: Paise; netPaise: Paise; bills: number }>;
  byChannel: Record<string, { bills: number; netSalesPaise: Paise }>;
  discountsByOffer: Record<string, Paise>;
  invoices: { first: string | null; last: string | null; cancelled: string[] };
  reconciliation: { status: "matched" | "mismatch"; mismatches: Mismatch[] };
}

const IST = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" });
/** The IST calendar date of an instant, whatever offset it was written with. */
export function istDate(iso: string): string {
  return IST.format(new Date(iso));
}

export function buildDayEnd(args: {
  storeCode: string;
  date: string;
  orders: readonly LedgerOrder[]; // this store's orders, covering at least the lookback for refunds
  bills: readonly Bill[]; // this till's bills for the store
  creditNotes: readonly CreditNote[]; // this till's credit notes for the store
}): DayEndReport {
  const { date } = args;
  const dayOrders = args.orders.filter((o) => istDate(o.createdAt) === date);
  const live = dayOrders.filter((o) => !o.cancelled);
  const dayRefunds = args.orders.flatMap((o) => o.refunds.filter((r) => istDate(r.createdAt) === date).map((r) => ({ r, order: o })));

  const sum = <T>(xs: readonly T[], f: (x: T) => Paise) => xs.reduce((a, x) => a + f(x), 0);
  const sales: Totals = {
    bills: live.length,
    grossPaise: sum(live, (o) => o.grossPaise),
    discountPaise: sum(live, (o) => o.discountPaise),
    taxablePaise: sum(live, (o) => o.netPaise - o.taxPaise),
    cgstPaise: sum(live, (o) => o.cgstPaise),
    sgstPaise: sum(live, (o) => o.sgstPaise),
    taxPaise: sum(live, (o) => o.taxPaise),
    netSalesPaise: sum(live, (o) => o.netPaise),
  };
  const paidBills = live.filter((o) => o.netPaise > 0);
  const refundAmount = sum(dayRefunds, (x) => x.r.amountPaise);
  const refundTax = sum(dayRefunds, (x) => x.r.taxPaise);

  const byPaymentMethod: DayEndReport["byPaymentMethod"] = {};
  const pm = (m: string) => (byPaymentMethod[m] ??= { salesPaise: 0, refundsPaise: 0, netPaise: 0, bills: 0 });
  for (const o of live) {
    if (o.salePaise === 0) continue;
    const row = pm(o.paymentMethod ?? "unknown");
    row.salesPaise += o.salePaise;
    row.bills += 1;
  }
  // A refund goes back the way the bill was paid.
  for (const { r, order } of dayRefunds) pm(order.paymentMethod ?? "unknown").refundsPaise += r.amountPaise;
  for (const row of Object.values(byPaymentMethod)) row.netPaise = row.salesPaise - row.refundsPaise;

  const byChannel: DayEndReport["byChannel"] = {};
  for (const o of live) {
    const row = (byChannel[o.channel ?? "unknown"] ??= { bills: 0, netSalesPaise: 0 });
    row.bills += 1;
    row.netSalesPaise += o.netPaise;
  }

  const discountsByOffer: Record<string, Paise> = {};
  for (const o of live) for (const d of o.discounts) discountsByOffer[d.code] = (discountsByOffer[d.code] ?? 0) + d.amountPaise;

  // ---------------------------------------------------------------- reconciliation with the till
  const mismatches: Mismatch[] = [];
  const flag = (kind: MismatchKind, ref: string, detail: string) => mismatches.push({ kind, severity: SEVERITY[kind], ref, detail });
  const dayBills = args.bills.filter((b) => istDate(b.createdAt) === date);
  const shopifyByInvoice = new Map(dayOrders.filter((o) => o.invoiceNo).map((o) => [o.invoiceNo!, o]));
  const tillInvoices = new Set(args.bills.map((b) => b.invoiceNo));

  for (const b of dayBills) {
    const o = shopifyByInvoice.get(b.invoiceNo);
    if (b.status === "POSTED") {
      if (!o) flag("MISSING_IN_SHOPIFY", b.invoiceNo, `Till shows ${b.invoiceNo} posted as ${b.posted?.orderName}, but Shopify has no order for it on ${date}.`);
      else if (o.netPaise !== b.totals.payablePaise) flag("AMOUNT_DIFFERS", b.invoiceNo, `Till ${b.totals.payablePaise} paise, Shopify ${o.netPaise} paise.`);
    } else if (b.status === "CHARGED" || b.status === "CHARGED_NOT_POSTED") {
      flag("NOT_POSTED", b.invoiceNo, `Paid ${b.totals.payablePaise} paise by ${b.paymentMethod} but not yet in Shopify${b.lastError ? `: ${b.lastError}` : ""}.`);
    } else if (b.status === "NUMBERED") {
      flag("NOT_POSTED", b.invoiceNo, `Payment not confirmed; resume or cancel this bill before closing the day.`);
    }
  }
  for (const o of dayOrders) {
    if (o.invoiceNo && !tillInvoices.has(o.invoiceNo)) {
      flag("NOT_FROM_THIS_TILL", o.invoiceNo, `${o.orderName} is in Shopify for this store but was not billed by this till.`);
    }
    if (!o.cancelled && o.salePaise !== o.netPaise) {
      flag("PAYMENT_NOT_CAPTURED", o.invoiceNo ?? o.orderName, `Order total ${o.netPaise} paise, captured ${o.salePaise} paise.`);
    }
  }
  for (const cn of args.creditNotes) {
    if ((cn.status === "REFUNDED" || cn.status === "REFUNDED_NOT_POSTED") && istDate(cn.createdAt) === date) {
      flag("REFUND_NOT_POSTED", cn.creditNoteNo, `Money returned for ${cn.invoiceNo} but the refund is not yet in Shopify.`);
    }
  }

  const numbered = dayBills.map((b) => b.invoiceNo).sort();
  return {
    storeCode: args.storeCode,
    date,
    source: "shopify",
    sales: {
      ...sales,
      zeroValueBills: live.length - paidBills.length,
      cancelledBills: dayOrders.length - live.length,
      averageBillPaise: paidBills.length ? Math.round(sum(paidBills, (o) => o.netPaise) / paidBills.length) : 0,
    },
    refunds: { count: dayRefunds.length, amountPaise: refundAmount, taxablePaise: refundAmount - refundTax, taxPaise: refundTax },
    netAfterRefundsPaise: sales.netSalesPaise - refundAmount,
    byPaymentMethod,
    byChannel,
    discountsByOffer,
    invoices: {
      first: numbered[0] ?? null,
      last: numbered.at(-1) ?? null,
      cancelled: dayBills.filter((b) => b.status === "CANCELLED").map((b) => b.invoiceNo),
    },
    reconciliation: { status: mismatches.some((m) => m.severity === "error") ? "mismatch" : "matched", mismatches },
  };
}
