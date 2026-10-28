import type { Bill, BillLine, BillStatus, CreditNoteStatus } from "../api/types";
import { dateTime, label, money, ratePct } from "../lib/format";
import { Pill, Row, type Tone } from "./ui";

export const billTone = (s: BillStatus): Tone => (s === "POSTED" ? "success" : s === "CANCELLED" ? "error" : s === "NUMBERED" ? "warn" : "info");
export const creditTone = (s: CreditNoteStatus): Tone => (s === "POSTED" ? "success" : s === "CANCELLED" ? "error" : s === "NUMBERED" ? "warn" : "info");

export function BillLines({ lines }: { lines: BillLine[] }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr><th>Item</th><th className="num">MRP</th><th className="num">Discount</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Total</th></tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineId}>
              <td>{l.title}<div className="small muted mono">{l.sku} · HSN {l.hsn}{l.rxId ? ` · ${l.rxId}` : ""}</div></td>
              <td className="num">{money(l.grossPaise)}</td>
              <td className="num">{l.discountPaise ? `−${money(l.discountPaise)}` : "—"}</td>
              <td className="num">{money(l.taxablePaise)}</td>
              <td className="num">{ratePct(l.rateBps)}</td>
              <td className="num">{money(l.cgstPaise)}</td>
              <td className="num">{money(l.sgstPaise)}</td>
              <td className="num">{money(l.totalPaise)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BillTotals({ bill }: { bill: Pick<Bill, "totals" | "appliedOffers" | "manualDiscount"> }) {
  const t = bill.totals;
  return (
    <div>
      <Row k="MRP (incl. GST)" v={money(t.grossPaise)} />
      {bill.appliedOffers.map((o) => <Row key={o.offerId} k={<span className="muted">{o.name}</span>} v={`−${money(o.amountPaise)}`} />)}
      {bill.manualDiscount && <Row k={<span className="muted">Manager discount ({bill.manualDiscount.bps / 100}% · {bill.manualDiscount.reasonCode})</span>} v="included above" />}
      <Row k="Total discount" v={`−${money(t.discountPaise)}`} />
      <Row k="Taxable value" v={money(t.taxablePaise)} />
      <Row k="CGST" v={money(t.cgstPaise)} />
      <Row k="SGST" v={money(t.sgstPaise)} />
      <Row strong k="Payable" v={money(t.payablePaise)} />
    </div>
  );
}

/** Printable invoice summary. Shown for POSTED bills, and for paid-but-not-yet-confirmed ones (Shopify ref pending). */
export function Receipt({ bill }: { bill: Bill }) {
  return (
    <div className="receipt stack">
      <div className="between">
        <div>
          <h3 className="mono">{bill.invoiceNo}</h3>
          <div className="muted small">{bill.store} · {bill.invoiceDate} · {label(bill.channel)}</div>
        </div>
        <Pill tone={billTone(bill.status)}>{bill.status.replace(/_/g, " ")}</Pill>
      </div>
      <div className="small">
        <div><b>Customer:</b> {bill.customer.name} · {bill.customer.phone}</div>
        <div>
          <b>Shopify order:</b>{" "}
          {bill.shopify ? <span className="mono">{bill.shopify.orderName} (id {bill.shopify.orderId})</span> : <span className="muted">not confirmed yet</span>}
        </div>
        {bill.payment && (
          <div>
            <b>Payment:</b> {bill.payment.method.toUpperCase()} · {money(bill.payment.amountPaise)} · {dateTime(bill.payment.at)}
            {bill.payment.chargeId && <> · charge <span className="mono">{bill.payment.chargeId}</span></>}
          </div>
        )}
      </div>
      <BillLines lines={bill.lines} />
      <BillTotals bill={bill} />
    </div>
  );
}
