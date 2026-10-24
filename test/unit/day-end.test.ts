import { describe, expect, it } from "vitest";
import { buildDayEnd, istDate, type LedgerOrder } from "../../src/domain/dayEnd.js";
import type { Bill } from "../../src/domain/bill.js";
import type { CreditNote } from "../../src/domain/refund.js";
import { postedBill } from "../support/bills.js";

const order = (over: Partial<LedgerOrder> = {}): LedgerOrder => ({
  orderRef: "1", orderName: "#2000", invoiceNo: "ELU/HSR/FY26/00003", createdAt: "2026-10-23T12:00:00+05:30", channel: "walk_in",
  paymentMethod: "upi", cancelled: false, grossPaise: 2049700, discountPaise: 180000, taxPaise: 199693, cgstPaise: 99847, sgstPaise: 99846,
  netPaise: 1869700, discounts: [{ code: "PRIORITY500", amountPaise: 50000 }, { code: "BUNDLE300", amountPaise: 30000 }, { code: "FREE_BLUECUT_PGX", amountPaise: 100000 }],
  salePaise: 1869700, refunds: [], ...over,
});
const bill = (over: Partial<Bill> = {}) => postedBill({ createdAt: "2026-10-23T06:30:00.000Z", ...over });
const report = (orders: LedgerOrder[], bills: Bill[] = [], creditNotes: CreditNote[] = [], date = "2026-10-23") => buildDayEnd({ storeCode: "HSR", date, orders, bills, creditNotes });

describe("istDate", () => {
  it("uses the IST calendar day whatever the offset", () => {
    expect(istDate("2026-10-06T20:00:00Z")).toBe("2026-10-07"); // 01:30 IST next day
    expect(istDate("2026-10-06T23:59:59+05:30")).toBe("2026-10-06");
    expect(istDate("2026-10-06T18:29:59Z")).toBe("2026-10-06");
  });
});

describe("buildDayEnd", () => {
  it("totals, tax, discounts by offer, payment and channel split", () => {
    const r = report([order(), order({ orderRef: "2", invoiceNo: "ELU/HSR/FY26/00004", paymentMethod: "cash", channel: "whatsapp_booked", grossPaise: 499800, discountPaise: 0, taxPaise: 76241, cgstPaise: 38121, sgstPaise: 38120, netPaise: 499800, salePaise: 499800, discounts: [] })],
      [bill(), bill({ invoiceNo: "ELU/HSR/FY26/00004", totals: { ...bill().totals, payablePaise: 499800 } })]);
    expect(r.sales).toEqual({
      bills: 2, grossPaise: 2549500, discountPaise: 180000, taxablePaise: 2093566, cgstPaise: 137968, sgstPaise: 137966, taxPaise: 275934,
      netSalesPaise: 2369500, zeroValueBills: 0, cancelledBills: 0, averageBillPaise: 1184750,
    });
    expect(r.sales.taxablePaise + r.sales.taxPaise).toBe(r.sales.netSalesPaise);
    expect(r.byPaymentMethod).toEqual({ upi: { salesPaise: 1869700, refundsPaise: 0, netPaise: 1869700, bills: 1 }, cash: { salesPaise: 499800, refundsPaise: 0, netPaise: 499800, bills: 1 } });
    expect(r.byChannel).toEqual({ walk_in: { bills: 1, netSalesPaise: 1869700 }, whatsapp_booked: { bills: 1, netSalesPaise: 499800 } });
    expect(r.discountsByOffer).toEqual({ PRIORITY500: 50000, BUNDLE300: 30000, FREE_BLUECUT_PGX: 100000 });
    expect(r.reconciliation).toEqual({ status: "matched", mismatches: [] });
    expect(r.invoices).toEqual({ first: "ELU/HSR/FY26/00003", last: "ELU/HSR/FY26/00004", cancelled: [] });
  });

  it("a refund counts on the day it was made, against the method the bill was paid with", () => {
    const earlier = order({ createdAt: "2026-10-20T12:00:00+05:30", refunds: [{ refundRef: "r1", creditNoteNo: "ELU/HSR/FY26/CN/00003", createdAt: "2026-10-23T16:00:00+05:30", amountPaise: 1869700, taxPaise: 199693 }] });
    const today = report([earlier]);
    expect(today.sales.bills).toBe(0);
    expect(today.refunds).toEqual({ count: 1, amountPaise: 1869700, taxablePaise: 1670007, taxPaise: 199693 });
    expect(today.netAfterRefundsPaise).toBe(-1869700);
    expect(today.byPaymentMethod.upi).toEqual({ salesPaise: 0, refundsPaise: 1869700, netPaise: -1869700, bills: 0 });
    expect(report([earlier], [], [], "2026-10-20").refunds.count).toBe(0);
  });

  it("zero-value bills (remakes) count as bills but not in the average; cancelled orders are excluded", () => {
    const r = report([order(), order({ orderRef: "2", invoiceNo: null, netPaise: 0, salePaise: 0, taxPaise: 0, cgstPaise: 0, sgstPaise: 0, discountPaise: 949900, grossPaise: 949900, discounts: [] }), order({ orderRef: "3", invoiceNo: null, cancelled: true })], [bill()]);
    expect(r.sales).toMatchObject({ bills: 2, zeroValueBills: 1, cancelledBills: 1, averageBillPaise: 1869700 });
  });

  it("flags each way the till and Shopify can disagree", () => {
    const cn = { creditNoteNo: "ELU/HSR/FY26/CN/00003", invoiceNo: "ELU/HSR/FY26/00001", status: "REFUNDED_NOT_POSTED", createdAt: "2026-10-23T09:00:00.000Z" } as CreditNote;
    const r = report(
      [
        order({ netPaise: 1869600 }), // 00003: amount differs (and so no longer equals the captured sale)
        order({ orderRef: "9", invoiceNo: "ELU/HSR/FY26/00002", orderName: "#1500" }), // old POS
        order({ orderRef: "8", invoiceNo: "ELU/HSR/FY26/00007", salePaise: 0 }), // not captured, and not this till's
      ],
      [
        bill(),
        bill({ invoiceNo: "ELU/HSR/FY26/00004" }), // posted per the till, not in Shopify
        bill({ invoiceNo: "ELU/HSR/FY26/00005", status: "CHARGED_NOT_POSTED", posted: null, lastError: "Shopify unreachable" }),
        bill({ invoiceNo: "ELU/HSR/FY26/00006", status: "CANCELLED", posted: null }),
      ],
      [cn],
    );
    expect(r.reconciliation.status).toBe("mismatch");
    expect(r.reconciliation.mismatches.map((m) => [m.kind, m.severity, m.ref])).toEqual([
      ["AMOUNT_DIFFERS", "error", "ELU/HSR/FY26/00003"],
      ["MISSING_IN_SHOPIFY", "error", "ELU/HSR/FY26/00004"],
      ["NOT_POSTED", "error", "ELU/HSR/FY26/00005"],
      ["PAYMENT_NOT_CAPTURED", "error", "ELU/HSR/FY26/00003"],
      ["NOT_FROM_THIS_TILL", "info", "ELU/HSR/FY26/00002"],
      ["NOT_FROM_THIS_TILL", "info", "ELU/HSR/FY26/00007"],
      ["PAYMENT_NOT_CAPTURED", "error", "ELU/HSR/FY26/00007"],
      ["REFUND_NOT_POSTED", "error", "ELU/HSR/FY26/CN/00003"],
    ]);
    expect(r.invoices.cancelled).toEqual(["ELU/HSR/FY26/00006"]);
  });

  it("orders from the old POS alone are information, not a failed day", () => {
    expect(report([order({ invoiceNo: "ELU/HSR/FY26/00001" })]).reconciliation.status).toBe("matched");
  });
});
