import { describe, expect, it } from "vitest";
import { planFullRefund } from "../../src/domain/refund.js";
import { postedBill } from "../support/bills.js";

const plan = (bill = postedBill()) => planFullRefund({ bill, creditNoteNo: "ELU/HSR/FY26/CN/00003", staffId: "S105", reasonCode: "CHANGED_MIND", note: null, now: "2026-10-24T05:00:00.000Z" });

describe("planFullRefund", () => {
  it("reverses every line exactly as invoiced, frame back to the billing store, lens scrapped", () => {
    const bill = postedBill();
    const cn = plan(bill);
    expect(cn.lines.map(({ lineRef, kind, amountPaise, taxablePaise, cgstPaise, sgstPaise, restock }) => ({ lineRef, kind, amountPaise, taxablePaise, cgstPaise, sgstPaise, restock }))).toEqual([
      { lineRef: "96000100", kind: "frame", amountPaise: 1054673, taxablePaise: 893791, cgstPaise: 80441, sgstPaise: 80441, restock: { type: "return", locationRef: "70000002" } },
      { lineRef: "96000101", kind: "lens", amountPaise: 815027, taxablePaise: 776216, cgstPaise: 19406, sgstPaise: 19405, restock: { type: "no_restock" } },
    ]);
    for (const [i, l] of cn.lines.entries()) {
      const b = bill.lines[i]!;
      expect([l.taxablePaise, l.cgstPaise, l.sgstPaise, l.amountPaise]).toEqual([b.taxablePaise, b.cgstPaise, b.sgstPaise, b.netPaise]);
    }
    expect(cn.totals).toEqual({ amountPaise: 1869700, taxablePaise: 1670007, cgstPaise: 99847, sgstPaise: 99846 });
    expect(cn.source).toEqual({ orderRef: "95000100", saleTransactionRef: "97000100", chargeId: "chg_1" });
    expect(cn).toMatchObject({ status: "NUMBERED", invoiceNo: "ELU/HSR/FY26/00003", refundMethod: "upi", checked: false });
  });

  it.each([
    ["not yet in Shopify", { status: "CHARGED_NOT_POSTED" as const, posted: null }, /must be confirmed in Shopify.*Resume the bill first/],
    ["cancelled", { status: "CANCELLED" as const, posted: null }, /was cancelled; there is nothing to refund/],
    ["zero-value", { payment: { method: "upi" as const, amountPaise: 0, chargeId: null, at: "x" } }, /zero-value bill/],
  ])("refuses a bill that is %s", (_l, over, msg) => {
    expect(() => plan(postedBill(over))).toThrow(expect.objectContaining({ code: "REFUND_NOT_ALLOWED", message: expect.stringMatching(msg) }));
  });
});
