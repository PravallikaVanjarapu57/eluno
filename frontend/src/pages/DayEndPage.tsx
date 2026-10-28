import { BarChart3, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { DayEndReport } from "../api/types";
import { Banner, Card, ErrorBanner, Field, Pill, Spinner } from "../components/ui";
import { label, money, todayIST } from "../lib/format";
import { useAuth } from "../state/auth";
import { useSession } from "../state/session";

export default function DayEndPage() {
  const { can } = useAuth();
  // Hidden from salespeople in the menu; the server also refuses them. Until the client confirms otherwise, reports are manager-only.
  if (!can("report:view")) {
    return <div className="page"><Banner tone="warn" title="Day-end reports are for store managers">Ask your store manager for the day-end report.</Banner></div>;
  }
  return <DayEnd />;
}

function DayEnd() {
  const { can } = useAuth();
  const { stores, storeCode } = useSession();
  const [store, setStore] = useState(storeCode);
  const [date, setDate] = useState(todayIST());
  const [report, setReport] = useState<DayEndReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const seq = useRef(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<unknown>(null);

  async function exportCsv() {
    if (!report || exporting) return;
    setExporting(true);
    setExportError(null);
    try {
      // Re-asks the server for the same store and date as the report on screen; the server decides if you may.
      const { blob, filename } = await api.dayEndCsv(report.storeCode, report.date);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => { if (!store && storeCode) setStore(storeCode); }, [storeCode, store]);

  async function run() {
    if (!store || !date) return;
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await api.dayEnd(store, date);
      if (mine === seq.current) setReport(r);
    } catch (e) {
      if (mine === seq.current) { setError(e); setReport(null); }
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  return (
    <div className="page">
      <h1>Day-end report</h1>
      <Card title="Store and date">
        <form className="fields" onSubmit={(e) => { e.preventDefault(); void run(); }}>
          <Field label="Store"><select value={store} onChange={(e) => setStore(e.target.value)}><option value="">Select store…</option>{stores?.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}</select></Field>
          <Field label="Business date (IST)"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          <div style={{ alignSelf: "end" }}><button className="primary" type="submit" disabled={!store || !date || loading}><BarChart3 size={16} className="icon" aria-hidden />{loading ? "Loading…" : "Show report"}</button></div>
        </form>
        <ErrorBanner error={error} actions={error instanceof ApiError && error.outcomeUnknown ? <button onClick={run}>Retry</button> : undefined} />
        {loading && <Spinner label="Reading orders from Shopify and reconciling with the till…" />}
      </Card>
      {report && can("report:download") && (
        <div className="inline no-print">
          <button className="primary" onClick={exportCsv} disabled={exporting}><Download size={16} className="icon" aria-hidden />{exporting ? "Preparing…" : `Download CSV · ${report.storeCode} ${report.date}`}</button>
          <span className="small muted">The same figures as this report, as a spreadsheet file.</span>
        </div>
      )}
      <ErrorBanner error={exportError} title="Could not download the report" />
      {report && <Report r={report} />}
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return <div className="stat"><small>{k}</small><b>{v}</b>{sub && <div className="small muted">{sub}</div>}</div>;
}

function Report({ r }: { r: DayEndReport }) {
  const errors = r.reconciliation.mismatches.filter((m) => m.severity === "error");
  const infos = r.reconciliation.mismatches.filter((m) => m.severity === "info");
  const matched = r.reconciliation.status === "matched";
  return (
    <>
      {matched ? (
        <Banner tone="success" title="Reconciled">Shopify and the till agree for {r.storeCode} on {r.date}.{infos.length > 0 && ` ${infos.length} informational note(s) below.`}</Banner>
      ) : (
        <Banner tone="error" title={`Does not reconcile · ${errors.length} problem${errors.length === 1 ? "" : "s"}`}>
          Shopify and the till disagree for {r.storeCode} on {r.date}. Fix each item below before closing the day.
        </Banner>
      )}
      {r.reconciliation.mismatches.length > 0 && (
        <Card title="Reconciliation details">
          <div className="scroll"><table>
            <thead><tr><th>Severity</th><th>Type</th><th>Reference</th><th>Detail</th></tr></thead>
            <tbody>
              {[...errors, ...infos].map((m, i) => (
                <tr key={i}><td><Pill tone={m.severity === "error" ? "error" : "info"}>{m.severity}</Pill></td><td className="mono">{m.kind}</td><td className="mono">{m.ref}</td><td>{m.detail}</td></tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      <div className="cards">
        <Stat k="Bills" v={String(r.sales.bills)} sub={`avg ${money(r.sales.averageBillPaise)}${r.sales.cancelledBills ? ` · ${r.sales.cancelledBills} cancelled` : ""}`} />
        <Stat k="Gross sales (MRP)" v={money(r.sales.grossPaise)} />
        <Stat k="Discounts" v={money(r.sales.discountPaise)} />
        <Stat k="Taxable value" v={money(r.sales.taxablePaise)} />
        <Stat k="GST" v={money(r.sales.taxPaise)} sub={`CGST ${money(r.sales.cgstPaise)} · SGST ${money(r.sales.sgstPaise)}`} />
        <Stat k="Net sales" v={money(r.sales.netSalesPaise)} />
        <Stat k="Refunds" v={money(r.refunds.amountPaise)} sub={`${r.refunds.count} refund${r.refunds.count === 1 ? "" : "s"} · GST reversed ${money(r.refunds.taxPaise)}`} />
        <Stat k="Net after refunds" v={money(r.netAfterRefundsPaise)} />
      </div>

      <div className="grid-2">
        <Card title="By payment method">
          <table>
            <thead><tr><th>Method</th><th className="num">Bills</th><th className="num">Sales</th><th className="num">Refunds</th><th className="num">Net</th></tr></thead>
            <tbody>{Object.entries(r.byPaymentMethod).map(([k, v]) => <tr key={k}><td>{k.toUpperCase()}</td><td className="num">{v.bills}</td><td className="num">{money(v.salesPaise)}</td><td className="num">{money(v.refundsPaise)}</td><td className="num">{money(v.netPaise)}</td></tr>)}</tbody>
          </table>
          {Object.keys(r.byPaymentMethod).length === 0 && <div className="muted">No payments on this day.</div>}
        </Card>
        <Card title="By sales channel">
          <table>
            <thead><tr><th>Channel</th><th className="num">Bills</th><th className="num">Net sales</th></tr></thead>
            <tbody>{Object.entries(r.byChannel).map(([k, v]) => <tr key={k}><td>{label(k)}</td><td className="num">{v.bills}</td><td className="num">{money(v.netSalesPaise)}</td></tr>)}</tbody>
          </table>
          {Object.keys(r.byChannel).length === 0 && <div className="muted">No bills on this day.</div>}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Invoice series">
          <div className="small">
            <div><b>First:</b> <span className="mono">{r.invoices.first ?? "—"}</span></div>
            <div><b>Last:</b> <span className="mono">{r.invoices.last ?? "—"}</span></div>
            <div><b>Cancelled numbers:</b> {r.invoices.cancelled.length === 0 ? "none" : r.invoices.cancelled.map((c) => <span key={c} className="mono"> {c}</span>)}</div>
          </div>
        </Card>
        <Card title="Discounts by offer">
          {Object.keys(r.discountsByOffer).length === 0 ? <div className="muted">No discounts given.</div> : (
            <table><tbody>{Object.entries(r.discountsByOffer).map(([k, v]) => <tr key={k}><td className="mono">{k}</td><td className="num">{money(v)}</td></tr>)}</tbody></table>
          )}
        </Card>
      </div>
      <div className="small muted">Source: {r.source}. Sales count on the day the order was created; refunds count on the day they were made.</div>
    </>
  );
}
