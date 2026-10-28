import { Printer, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { Bill, BillSummary, CreditNote } from "../api/types";
import { BillLines, BillTotals, billTone, creditTone } from "../components/BillParts";
import { Banner, Card, ErrorBanner, Field, Pill, Row, Spinner } from "../components/ui";
import { dateTime, label, money, ratePct } from "../lib/format";
import { useAuth } from "../state/auth";
import { useSession } from "../state/session";

export default function RefundsPage() {
  const { storeCode, reasonCodes } = useSession();
  const [params, setParams] = useSearchParams();
  const [invoice, setInvoice] = useState(params.get("invoice") ?? "");
  const [bill, setBill] = useState<Bill | null>(null);
  const [notes, setNotes] = useState<CreditNote[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const open = useCallback(async (raw: string) => {
    const no = raw.trim();
    if (!no) return;
    setLoading(true);
    setError(null);
    setBill(null);
    setNotes(null);
    try {
      const [b, n] = await Promise.all([api.bill(no), api.refundsFor(no)]);
      setBill(b);
      setNotes(n);
      setInvoice(no);
      setParams({ invoice: no }, { replace: true });
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [setParams]);

  useEffect(() => {
    const q = params.get("invoice");
    if (q) void open(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="page">
      <h1>Refunds</h1>
      <Card title="1 · Find the bill">
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void open(invoice); }}>
          <div style={{ flex: "1 1 320px" }}><Field label="Invoice number" hint="As printed on the invoice, e.g. ELU/HSR/FY26/00003"><input value={invoice} onChange={(e) => setInvoice(e.target.value)} placeholder="ELU/HSR/FY26/00003" autoCapitalize="characters" /></Field></div>
          <button className="primary" type="submit" disabled={!invoice.trim() || loading} style={{ alignSelf: "flex-end" }}><Search size={16} className="icon" aria-hidden />{loading ? "Loading…" : "Load bill"}</button>
        </form>
        <ErrorBanner error={error} actions={error instanceof ApiError && error.outcomeUnknown ? <button onClick={() => open(invoice)}>Retry</button> : undefined} />
        {storeCode && <RecentBills storeCode={storeCode} onPick={(no) => { setInvoice(no); void open(no); }} />}
      </Card>

      {loading && <Spinner label="Loading the bill and its refunds…" />}
      {bill && notes && <RefundPanel key={bill.invoiceNo} bill={bill} notes={notes} reasons={reasonCodes?.refund ?? []} onChange={() => open(bill.invoiceNo)} />}
    </div>
  );
}

function RecentBills({ storeCode, onPick }: { storeCode: string; onPick(no: string): void }) {
  const [bills, setBills] = useState<BillSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!show) return;
    setError(null);
    api.recentBills(storeCode, 15).then(setBills).catch(setError);
  }, [show, storeCode]);
  return (
    <div className="stack">
      <button className="link" style={{ justifySelf: "start" }} onClick={() => setShow((s) => !s)}>{show ? "Hide" : "Or pick from"} recent bills at {storeCode}</button>
      {show && <ErrorBanner error={error} />}
      {show && !bills && !error && <Spinner />}
      {show && bills?.map((b) => (
        <button key={b.invoiceNo} className="list-btn" onClick={() => onPick(b.invoiceNo)}>
          <span><span className="mono">{b.invoiceNo}</span> · {b.customerName}<br /><span className="small muted">{dateTime(b.createdAt)}</span></span>
          <span><Pill tone={billTone(b.status)}>{b.status.replace(/_/g, " ")}</Pill> {money(b.payablePaise)}</span>
        </button>
      ))}
    </div>
  );
}

const ACTIVE = new Set(["NUMBERED", "REFUNDED", "REFUNDED_NOT_POSTED"]);

function RefundPanel({ bill, notes, reasons, onChange }: {
  bill: Bill; notes: CreditNote[]; reasons: { code: string; label: string }[]; onChange(): void;
}) {
  const { user } = useAuth();
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<CreditNote | null>(null);
  const [lost, setLost] = useState(false);
  const inflight = useRef(false);

  const live = result && ACTIVE.has(result.status) ? result : notes.find((n) => ACTIVE.has(n.status)) ?? null;
  const done = result?.status === "POSTED" ? result : notes.find((n) => n.status === "POSTED") ?? null;
  const refundable = bill.status === "POSTED" && !live && !done;

  async function submit() {
    if (inflight.current) return; // never two refund requests from one screen
    inflight.current = true;
    setBusy(true);
    setConfirming(false);
    setError(null);
    setLost(false);
    try {
      const r = await api.refund(bill.invoiceNo, { reasonCode: reason, ...(note.trim() ? { note: note.trim() } : {}) });
      setResult(r.data);
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.outcomeUnknown) {
        // The answer was lost: ask the server what exists instead of re-sending the refund.
        setLost(true);
        try {
          const existing = (await api.refundsFor(bill.invoiceNo)).find((n) => n.status !== "CANCELLED");
          if (existing) { setResult(existing); setLost(false); setError(null); }
        } catch { /* stays "unknown"; staff can press Check */ }
      }
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <>
      <Card title={<>2 · Original bill <span className="mono">{bill.invoiceNo}</span> <Pill tone={billTone(bill.status)}>{bill.status.replace(/_/g, " ")}</Pill></>}>
        <div className="small">
          <div><b>{bill.customer.name}</b> · {bill.customer.phone} · {bill.store} · {bill.invoiceDate} · {label(bill.channel)}</div>
          <div>Shopify: {bill.shopify ? <span className="mono">{bill.shopify.orderName}</span> : "not confirmed"} · paid by {bill.payment?.method.toUpperCase() ?? "—"}{bill.payment?.chargeId && <> · <span className="mono">{bill.payment.chargeId}</span></>}</div>
        </div>
        <BillLines lines={bill.lines} />
        <BillTotals bill={bill} />
        <div className="small muted">A full refund returns the whole amount, reverses the GST line by line, puts the frame back in stock at {bill.store} and does not restock the lens.</div>
        {bill.status !== "POSTED" && <Banner tone="warn" title={`This bill is ${bill.status.replace(/_/g, " ").toLowerCase()}`}>{bill.nextStep}</Banner>}
      </Card>

      {notes.length > 0 && (
        <Card title="Refund history for this bill">
          {notes.map((n) => <CreditNoteView key={n.creditNoteNo} note={n} onChange={onChange} />)}
        </Card>
      )}

      {result && <Card title="Refund result"><CreditNoteView note={result} onChange={onChange} headline /></Card>}

      {lost && (
        <Banner tone="warn" title="Could not confirm whether the refund went through"
          actions={<button className="primary" onClick={onChange}>Check refund status</button>}>
          The connection dropped before the till answered. <b>Do not refund again.</b> Check the status; the server knows whether a credit note exists.
        </Banner>
      )}

      {refundable && (
        <Card title="3 · Refund in full">
          <div className="fields">
            <Field label="Refund processed by" hint="Recorded from your sign-in">
              <input readOnly value={user ? `${user.name} (${user.staffId})` : ""} />
            </Field>
            <Field label="Reason">
              <select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Select reason…</option>{reasons.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select>
            </Field>
          </div>
          <Field label="Note (optional)"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {!lost && <ErrorBanner error={error} />}
          {confirming ? (
            <Banner tone="warn" title={`Refund ${money(bill.totals.payablePaise)} to ${bill.payment?.method.toUpperCase()}?`}
              actions={<><button className="danger" onClick={submit} disabled={busy}>Yes, refund in full</button><button onClick={() => setConfirming(false)}>Back</button></>}>
              This cannot be undone. {bill.invoiceNo} will be refunded completely.
            </Banner>
          ) : (
            <button className="danger big" disabled={!reason || busy} onClick={() => setConfirming(true)}>{busy ? "Refunding…" : "Review full refund…"}</button>
          )}
          {busy && <Spinner label="Returning the money and recording it in Shopify…" />}
        </Card>
      )}
    </>
  );
}

function CreditNoteView({ note, onChange, headline = false }: { note: CreditNote; onChange(): void; headline?: boolean }) {
  const [current, setCurrent] = useState(note);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inflight = useRef(false);
  useEffect(() => setCurrent(note), [note]);

  const waiting = current.status === "REFUNDED" || current.status === "REFUNDED_NOT_POSTED";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => { api.creditNote(current.creditNoteNo).then(setCurrent).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, [waiting, current.creditNoteNo]);

  async function act(fn: () => Promise<CreditNote>) {
    if (inflight.current) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      const n = await fn();
      setCurrent(n);
      if (n.status === "POSTED") onChange();
    } catch (e) {
      setError(e);
      if (e instanceof ApiError && e.outcomeUnknown) api.creditNote(current.creditNoteNo).then(setCurrent).catch(() => {});
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  const n = current;
  return (
    <div className="receipt stack">
      <div className="between">
        <div><b className="mono">{n.creditNoteNo}</b> <span className="muted small">against {n.invoiceNo}</span></div>
        <Pill tone={creditTone(n.status)}>{n.status.replace(/_/g, " ")}</Pill>
      </div>

      {n.status === "POSTED" && headline && <Banner tone="success" title="Refund complete">{money(n.totals.amountPaise)} returned by {n.refundMethod.toUpperCase()} and recorded in Shopify (refund {n.shopify?.refundId}). Print the credit note.</Banner>}
      {n.status === "CANCELLED" && <Banner tone="error" title="Not refunded">{n.cancelReason ?? "The refund was cancelled."} No money was returned. The credit note number stays in the series as cancelled.</Banner>}
      {n.status === "NUMBERED" && (
        <Banner tone="warn" title="Refund not confirmed" actions={<button className="primary" onClick={() => act(() => api.resumeRefund(n.creditNoteNo))} disabled={busy}>Resume refund</button>}>
          The terminal did not confirm the money going back. Resume checks first and never pays out twice.{n.lastError && <div className="small">{n.lastError}</div>}
        </Banner>
      )}
      {waiting && (
        <Banner tone="info" title="Money returned · recording in Shopify" actions={<button onClick={() => act(() => api.resumeRefund(n.creditNoteNo))} disabled={busy}>Retry recording now</button>}>
          {n.nextStep}{n.lastError && <div className="small">Last problem: {n.lastError}</div>}
        </Banner>
      )}
      <ErrorBanner error={error} />
      {busy && <Spinner />}

      <div className="scroll">
        <table>
          <thead><tr><th>Item</th><th className="num">Refund</th><th className="num">Taxable</th><th className="num">GST</th><th className="num">CGST</th><th className="num">SGST</th><th>Stock</th></tr></thead>
          <tbody>
            {n.lines.map((l) => (
              <tr key={l.lineId}><td className="mono">{l.sku}</td><td className="num">{money(l.amountPaise)}</td><td className="num">{money(l.taxablePaise)}</td><td className="num">{ratePct(l.rateBps)}</td><td className="num">{money(l.cgstPaise)}</td><td className="num">{money(l.sgstPaise)}</td><td>{l.restock === "return" ? "Restocked" : "Not restocked"}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <Row strong k={`Refund total · ${label(n.reasonCode.toLowerCase())}`} v={money(n.totals.amountPaise)} />
      {n.status === "POSTED" && <button className="no-print" style={{ justifySelf: "start" }} onClick={() => window.print()}><Printer size={16} className="icon" aria-hidden />Print credit note</button>}
    </div>
  );
}
