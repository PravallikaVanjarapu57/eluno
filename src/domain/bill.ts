import type { Cart } from "./cart.js";
import { lensConfigKey } from "./catalog.js";
import type { Paise } from "./money.js";
import type { ManualDiscount } from "./offers/offer.js";
import type { Quote, QuoteLine } from "./pricing.js";
import type { EyeRx } from "./prescription.js";
import type { Channel, Store } from "./store.js";

// A bill is a cart frozen at checkout, with its invoice number, payment and posting state.
//
//   NUMBERED ── charge ok ──▶ CHARGED ── posted ──▶ POSTED
//      │                         └── posting failed ──▶ CHARGED_NOT_POSTED ── resume ──▶ POSTED
//      └── declined / abandoned ──▶ CANCELLED (the number stays in the series, marked cancelled)
//
// Every transition is saved before the next external call, so a crash or a dropped connection can always resume.

export const PAYMENT_METHODS = ["upi", "card", "cash"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export type BillStatus = "NUMBERED" | "CHARGED" | "CHARGED_NOT_POSTED" | "POSTED" | "CANCELLED";

export interface BillLine extends QuoteLine {
  variantId: string;
  title: string;
  offerAllocations: { offerId: string; amountPaise: Paise }[];
  lens: {
    rxId: string;
    configKey: string; // "progressive/1.6/blue_cut"
    od: EyeRx;
    os: EyeRx;
    pd: number | null;
    labTatDays: number;
  } | null;
}

export interface Payment {
  method: PaymentMethod;
  amountPaise: Paise;
  /** Terminal charge id; null for cash and zero-value bills. */
  chargeId: string | null;
  at: string;
}

export interface PostedOrder {
  orderRef: string;
  orderName: string;
  saleTransactionRef: string | null;
  /** Our lineId -> the system of record's line id (needed for refunds). */
  lineRefs: Record<string, string>;
}

export interface Bill {
  invoiceNo: string;
  status: BillStatus;
  cartId: string;
  store: { code: string; name: string; locationRef: string };
  customer: { id: string; name: string; phone: string };
  staffId: string;
  channel: Channel;
  paymentMethod: PaymentMethod;
  invoiceDate: string;
  createdAt: string;
  lines: BillLine[];
  appliedOffers: { offerId: string; name: string; amountPaise: Paise }[];
  manualDiscount: ManualDiscount | null;
  totals: { grossPaise: Paise; discountPaise: Paise; taxablePaise: Paise; cgstPaise: Paise; sgstPaise: Paise; taxPaise: Paise; payablePaise: Paise };
  payment: Payment | null;
  posted: PostedOrder | null;
  /** Last failure, for staff and for the day-end mismatch report. */
  lastError: string | null;
  cancelReason: string | null;
}

export function buildBill(args: { invoiceNo: string; cart: Cart; quote: Quote; store: Store; paymentMethod: PaymentMethod; now: string }): Bill {
  const { cart, quote } = args;
  const lines: BillLine[] = quote.lines.map((ql) => {
    const pair = cart.pairs.find((p) => p.pairRef === ql.pairRef)!;
    const offerAllocations = quote.offers.applied.flatMap((a) =>
      a.allocations.filter((x) => x.lineId === ql.lineId).map((x) => ({ offerId: a.offerId, amountPaise: x.amountPaise })),
    );
    if (ql.kind === "frame") return { ...ql, variantId: pair.frame!.variantId, title: pair.frame!.title, offerAllocations, lens: null };
    const { item, rx } = pair.lens!;
    return {
      ...ql,
      variantId: item.variantId,
      title: item.title,
      offerAllocations,
      lens: { rxId: rx.rxId, configKey: lensConfigKey(item.config), od: rx.od, os: rx.os, pd: rx.pd.binocular, labTatDays: item.labTatDays },
    };
  });
  return {
    invoiceNo: args.invoiceNo,
    status: "NUMBERED",
    cartId: cart.id,
    store: { code: args.store.code, name: args.store.name, locationRef: args.store.locationRef },
    customer: { id: cart.customer.id, name: `${cart.customer.firstName} ${cart.customer.lastName}`.trim(), phone: cart.customer.phone },
    staffId: cart.staffId,
    channel: cart.channel,
    paymentMethod: args.paymentMethod,
    invoiceDate: quote.invoiceDate,
    createdAt: args.now,
    lines,
    appliedOffers: quote.offers.applied.map((a) => ({ offerId: a.offerId, name: a.name, amountPaise: a.amountPaise })),
    manualDiscount: quote.offers.applied.some((a) => a.offerId === cart.manualDiscount?.offerId) ? cart.manualDiscount : null,
    totals: {
      grossPaise: quote.grossPaise,
      discountPaise: quote.discountPaise,
      taxablePaise: quote.taxablePaise,
      cgstPaise: quote.cgstPaise,
      sgstPaise: quote.sgstPaise,
      taxPaise: quote.taxPaise,
      payablePaise: quote.netPaise,
    },
    payment: null,
    posted: null,
    lastError: null,
    cancelReason: null,
  };
}

/** Invoice numbers: the store's prefix plus a zero-padded sequence, e.g. ELU/HSR/FY26/00042. */
export function formatInvoiceNo(prefix: string, seq: number): string {
  return `${prefix}${String(seq).padStart(5, "0")}`;
}

export function parseInvoiceSeq(prefix: string, invoiceNo: string): number | null {
  if (!invoiceNo.startsWith(prefix)) return null;
  const rest = invoiceNo.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}
