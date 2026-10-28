import type { Paise } from "./money.js";
import type { DayEndReport } from "./dayEnd.js";

// The downloadable day-end: the same DayEndReport the screen shows, flattened to rows. Nothing is recomputed here.
// Columns: section,item,count,amount_paise,amount_inr,detail. Amounts are exact integer paise; amount_inr is the same figure in rupees.

const HEADER = ["section", "item", "count", "amount_paise", "amount_inr", "detail"];

/** Integer paise -> "18697.00" without going through a float. */
export function rupees(paise: Paise): string {
  const abs = Math.abs(paise);
  return `${paise < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Text cells that start with = + - @ (or tab/CR) are formulas to a spreadsheet; a leading quote makes them text. */
function cell(value: string | number): string {
  let s = String(value);
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Row = [section: string, item: string, count: number | "", amount: Paise | "", detail: string];

export function dayEndToCsv(r: DayEndReport): string {
  const rows: Row[] = [];
  const money = (section: string, item: string, paise: Paise, count: number | "" = "", detail = ""): void => void rows.push([section, item, count, paise, detail]);

  rows.push(["report", "store", "", "", r.storeCode], ["report", "date", "", "", r.date], ["report", "source", "", "", r.source], ["report", "reconciliation", "", "", r.reconciliation.status]);

  rows.push(["sales", "bills", r.sales.bills, "", ""]);
  money("sales", "gross_mrp", r.sales.grossPaise);
  money("sales", "discounts", r.sales.discountPaise);
  money("sales", "taxable_value", r.sales.taxablePaise);
  money("sales", "cgst", r.sales.cgstPaise);
  money("sales", "sgst", r.sales.sgstPaise);
  money("sales", "gst_total", r.sales.taxPaise);
  money("sales", "net_sales", r.sales.netSalesPaise);
  money("sales", "average_bill", r.sales.averageBillPaise);
  rows.push(["sales", "zero_value_bills", r.sales.zeroValueBills, "", ""], ["sales", "cancelled_bills", r.sales.cancelledBills, "", ""]);

  money("refunds", "refunds", r.refunds.amountPaise, r.refunds.count);
  money("refunds", "taxable_value", r.refunds.taxablePaise);
  money("refunds", "gst_reversed", r.refunds.taxPaise);
  money("net", "net_after_refunds", r.netAfterRefundsPaise);

  for (const [method, v] of Object.entries(r.byPaymentMethod)) {
    money("payment_method", `${method} sales`, v.salesPaise, v.bills);
    money("payment_method", `${method} refunds`, v.refundsPaise);
    money("payment_method", `${method} net`, v.netPaise);
  }
  for (const [channel, v] of Object.entries(r.byChannel)) money("channel", channel, v.netSalesPaise, v.bills);
  for (const [offer, paise] of Object.entries(r.discountsByOffer)) money("discount_by_offer", offer, paise);

  rows.push(["invoices", "first", "", "", r.invoices.first ?? ""], ["invoices", "last", "", "", r.invoices.last ?? ""]);
  for (const no of r.invoices.cancelled) rows.push(["invoices", "cancelled", "", "", no]);
  for (const m of r.reconciliation.mismatches) rows.push(["mismatch", m.kind, "", "", `${m.severity} ${m.ref}: ${m.detail}`]);

  const lines = [HEADER, ...rows.map(([section, item, count, amount, detail]) => [section, item, count, amount, amount === "" ? "" : rupees(amount), detail])];
  return lines.map((l) => l.map((c) => cell(c)).join(",")).join("\r\n") + "\r\n";
}
