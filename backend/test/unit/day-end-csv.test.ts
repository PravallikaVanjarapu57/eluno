import { describe, expect, it } from "vitest";
import { dayEndToCsv, rupees } from "../../src/domain/dayEndCsv.js";
import type { DayEndReport } from "../../src/domain/dayEnd.js";
import { parseCsv } from "../support/csv.js";

const report: DayEndReport = {
  storeCode: "HSR",
  date: "2026-10-23",
  source: "shopify",
  sales: { bills: 2, grossPaise: 3000000, discountPaise: 250000, taxablePaise: 2400000, cgstPaise: 150000, sgstPaise: 150000, taxPaise: 300000, netSalesPaise: 2750000, zeroValueBills: 0, cancelledBills: 1, averageBillPaise: 1375000 },
  refunds: { count: 1, amountPaise: 1869700, taxablePaise: 1670007, taxPaise: 199693 },
  netAfterRefundsPaise: 880300,
  byPaymentMethod: { upi: { salesPaise: 1869700, refundsPaise: 1869700, netPaise: 0, bills: 1 }, cash: { salesPaise: 880300, refundsPaise: 0, netPaise: 880300, bills: 1 } },
  byChannel: { walk_in: { bills: 1, netSalesPaise: 880300 }, whatsapp_booked: { bills: 1, netSalesPaise: 1869700 } },
  discountsByOffer: { PRIORITY500: 50000, FESTIVE10: 200000 },
  invoices: { first: "ELU/HSR/FY26/00003", last: "ELU/HSR/FY26/00005", cancelled: ["ELU/HSR/FY26/00004"] },
  reconciliation: { status: "mismatch", mismatches: [{ kind: "NOT_POSTED", severity: "error", ref: "ELU/HSR/FY26/00005", detail: 'Paid, "maybe" not in Shopify, see =HYPERLINK("x")' }] },
};

const rows = () => parseCsv(dayEndToCsv(report));
const find = (section: string, item: string) => rows().find((r) => r[0] === section && r[1] === item);

describe("dayEndToCsv", () => {
  it("formats rupees from integer paise without floats", () => {
    expect(rupees(1869700)).toBe("18697.00");
    expect(rupees(5)).toBe("0.05");
    expect(rupees(-199693)).toBe("-1996.93");
    expect(rupees(0)).toBe("0.00");
  });

  it("has a fixed header and CRLF rows", () => {
    expect(dayEndToCsv(report).split("\r\n")[0]).toBe("section,item,count,amount_paise,amount_inr,detail");
    expect(dayEndToCsv(report).endsWith("\r\n")).toBe(true);
  });

  it("carries every total of the report, in exact paise and in rupees", () => {
    expect(find("sales", "bills")).toEqual(["sales", "bills", "2", "", "", ""]);
    expect(find("sales", "net_sales")).toEqual(["sales", "net_sales", "", "2750000", "27500.00", ""]);
    expect(find("sales", "gst_total")![3]).toBe("300000");
    expect(find("sales", "cgst")![3]).toBe("150000");
    expect(find("sales", "discounts")![3]).toBe("250000");
    expect(find("refunds", "refunds")).toEqual(["refunds", "refunds", "1", "1869700", "18697.00", ""]);
    expect(find("net", "net_after_refunds")![3]).toBe("880300");
  });

  it("breaks down payment methods, channels and offers like the report", () => {
    expect(find("payment_method", "upi sales")).toEqual(["payment_method", "upi sales", "1", "1869700", "18697.00", ""]);
    expect(find("payment_method", "upi net")![3]).toBe("0");
    expect(find("payment_method", "cash net")![3]).toBe("880300");
    expect(find("channel", "whatsapp_booked")).toEqual(["channel", "whatsapp_booked", "1", "1869700", "18697.00", ""]);
    expect(find("discount_by_offer", "FESTIVE10")![3]).toBe("200000");
  });

  it("lists the invoice series, cancelled numbers and every mismatch", () => {
    expect(find("invoices", "first")![5]).toBe("ELU/HSR/FY26/00003");
    expect(find("invoices", "cancelled")![5]).toBe("ELU/HSR/FY26/00004");
    expect(find("report", "reconciliation")![5]).toBe("mismatch");
    expect(find("mismatch", "NOT_POSTED")![5]).toContain("error ELU/HSR/FY26/00005");
  });

  it("quotes cells properly and neutralises spreadsheet formulas in text", () => {
    const detail = find("mismatch", "NOT_POSTED")![5]!;
    expect(detail).toContain('"maybe"'); // survived the quote round trip
    expect(detail.startsWith("error ")).toBe(true);
    const hostile = { ...report, reconciliation: { status: "mismatch" as const, mismatches: [{ kind: "=cmd|' /C calc'!A0" as never, severity: "info" as const, ref: "+1", detail: "@SUM(1)" }] } };
    const out = parseCsv(dayEndToCsv(hostile));
    const m = out.find((r) => r[0] === "mismatch")!;
    expect(m[1]!.startsWith("'=")).toBe(true);
  });

  it("an empty day still exports cleanly", () => {
    const empty: DayEndReport = { ...report, sales: { ...report.sales, bills: 0, grossPaise: 0, discountPaise: 0, taxablePaise: 0, cgstPaise: 0, sgstPaise: 0, taxPaise: 0, netSalesPaise: 0, cancelledBills: 0, averageBillPaise: 0 }, refunds: { count: 0, amountPaise: 0, taxablePaise: 0, taxPaise: 0 }, netAfterRefundsPaise: 0, byPaymentMethod: {}, byChannel: {}, discountsByOffer: {}, invoices: { first: null, last: null, cancelled: [] }, reconciliation: { status: "matched", mismatches: [] } };
    const out = parseCsv(dayEndToCsv(empty));
    expect(out.find((r) => r[1] === "net_sales")![3]).toBe("0");
    expect(out.find((r) => r[0] === "invoices" && r[1] === "first")![5]).toBe("");
    expect(out.every((r) => r.length === 6)).toBe(true);
  });
});
