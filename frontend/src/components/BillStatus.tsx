import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { Bill } from "../api/types";
import { money } from "../lib/format";
import { BillTotals, Receipt, billTone } from "./BillParts";
import { Banner, Card, ErrorBanner, Field, Pill, Spinner } from "./ui";

const POLL_MS = 5000;

/**
 * What happened to a bill after "Charge". Success is shown only when the server says POSTED.
 * Every non-final state offers a deliberate, server-supported recovery action; nothing here re-sends a charge by itself.
 */
export function BillStatus({ bill, staffId, onBill, onNewSale, onBackToCart }: {
  bill: Bill;
  staffId: string;
  onBill(b: Bill): void;
  onNewSale(): void;
  onBackToCart(): void;
}) {
  const [busy, setBusy] = useState<"check" | "resume" | "cancel" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const guard = useRef(false);

  // While paid-but-not-yet-confirmed, only read the bill: the server's recovery sweep does the posting.
  const waiting = bill.status === "CHARGED" || bill.status === "CHARGED_NOT_POSTED";
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => {
      api.bill(bill.invoiceNo).then(onBill).catch(() => { /* next tick will try again */ });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [waiting, bill.invoiceNo, onBill]);

  async function run(kind: "check" | "resume" | "cancel", fn: () => Promise<Bill>) {
    if (guard.current) return;
    guard.current = true;
    setBusy(kind);
    setError(null);
    try {
      onBill(await fn());
      if (kind === "cancel") setCancelling(false);
    } catch (e) {
      setError(e);
      // A write whose answer was lost: read the truth instead of guessing.
      if (kind !== "check" && e instanceof ApiError && e.outcomeUnknown) api.bill(bill.invoiceNo).then(onBill).catch(() => {});
    } finally {
      guard.current = false;
      setBusy(null);
    }
  }
  const check = () => run("check", () => api.bill(bill.invoiceNo));
  const resume = () => run("resume", async () => (await api.resumeBill(bill.invoiceNo)).data);
  const cancel = () => run("cancel", () => api.cancelBill(bill.invoiceNo, staffId, cancelReason.trim()));

  return (
    <div className="stack">
      {bill.status === "POSTED" && (
        <Banner tone="success" title={`Sale complete · ${bill.invoiceNo}`}>
          Confirmed in Shopify as <b>{bill.shopify?.orderName}</b>. {money(bill.totals.payablePaise)} paid by {bill.payment?.method.toUpperCase() ?? "—"}.
        </Banner>
      )}

      {bill.status === "CHARGED_NOT_POSTED" && (
        <Banner tone="warn" title={`Paid · ${bill.invoiceNo} · waiting for Shopify`}
          actions={<><button onClick={check} disabled={!!busy}>Check status</button><button onClick={resume} disabled={!!busy}>Retry posting now</button></>}>
          The customer has paid and can leave. Shopify has not confirmed the order yet; the till keeps retrying and never charges again. Print the invoice.
          {bill.lastError && <div className="small">Last problem: {bill.lastError}</div>}
        </Banner>
      )}

      {bill.status === "CHARGED" && (
        <Banner tone="info" title={`Paid · ${bill.invoiceNo} · posting to Shopify`} actions={<button onClick={check} disabled={!!busy}>Check status</button>}>
          <Spinner label="Waiting for Shopify to confirm…" />
        </Banner>
      )}

      {bill.status === "NUMBERED" && (
        <Banner tone="warn" title={`Payment not confirmed · ${bill.invoiceNo}`}
          actions={
            <>
              <button onClick={check} disabled={!!busy}>Check status</button>
              <button className="primary" onClick={resume} disabled={!!busy}>Resume (check terminal again)</button>
              <button onClick={() => setCancelling((c) => !c)} disabled={!!busy}>Cancel bill…</button>
            </>
          }>
          The terminal did not give a clear answer, so the customer <b>may</b> have paid. Look at the terminal first. Resume asks the terminal again for
          the same invoice and cannot charge twice. Cancel only if nothing was paid.
          {bill.lastError && <div className="small">{bill.lastError}</div>}
        </Banner>
      )}

      {bill.status === "NUMBERED" && cancelling && (
        <Card title="Cancel this unpaid bill">
          <Field label="Reason (at least 3 characters)"><input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. customer left without paying" /></Field>
          <div className="inline">
            <button className="danger" onClick={cancel} disabled={!!busy || cancelReason.trim().length < 3}>Confirm cancel</button>
            <button onClick={() => setCancelling(false)}>Keep bill</button>
          </div>
          <div className="small muted">The invoice number stays in the series, marked cancelled. The cart reopens.</div>
        </Card>
      )}

      {bill.status === "CANCELLED" && (
        <Banner tone="error" title={`Not paid · ${bill.invoiceNo} cancelled`}
          actions={<><button className="primary" onClick={onBackToCart}>Back to cart</button><button onClick={onNewSale}>New sale</button></>}>
          {bill.cancelReason ?? "The payment did not go through."} No money was taken. The invoice number stays in the series as cancelled; a new attempt gets the next number.
        </Banner>
      )}

      {busy && <Spinner label={busy === "check" ? "Checking…" : busy === "resume" ? "Resuming…" : "Cancelling…"} />}
      <ErrorBanner error={error} />

      {bill.status !== "CANCELLED" && <Receipt bill={bill} />}
      {bill.status === "CANCELLED" && <Card title="Declined bill" className="small"><div className="inline"><Pill tone={billTone(bill.status)}>CANCELLED</Pill><span className="muted">{money(bill.totals.payablePaise)}</span></div><BillTotals bill={bill} /></Card>}

      {(bill.status === "POSTED" || bill.status === "CHARGED_NOT_POSTED") && (
        <div className="inline no-print">
          <button className="primary big" onClick={() => window.print()}>Print invoice</button>
          <button className="big" onClick={onNewSale}>New sale</button>
          {bill.status === "POSTED" && <Link className="btn big" to={`/refunds?invoice=${encodeURIComponent(bill.invoiceNo)}`}>Refund this bill…</Link>}
        </div>
      )}
    </div>
  );
}
