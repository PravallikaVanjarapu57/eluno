import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import { CHANNELS, type Bill, type BillSummary, type Cart, type Channel, type CustomerLookup } from "../api/types";
import { BillStatus } from "../components/BillStatus";
import { PrescriptionCard } from "../components/PrescriptionCard";
import { SaleBuilder } from "../components/SaleBuilder";
import { Banner, Card, ErrorBanner, Field, Pill, Spinner } from "../components/ui";
import { dateTime, money } from "../lib/format";
import { load, save } from "../lib/storage";
import { NewCustomer } from "../components/NewCustomer";
import { useAuth } from "../state/auth";
import { useSession } from "../state/session";

import { SAVED, type SavedSale } from "./StartSalePage";

export default function TillPage() {
  const { storeCode, store, stores } = useSession();
  const { user, can } = useAuth();
  const [phone, setPhone] = useState("");
  const [channel, setChannel] = useState<Channel>("walk_in");
  const [lookup, setLookup] = useState<CustomerLookup | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<"lookup" | "start" | "restore" | null>(() => (load<SavedSale>(SAVED) ? "restore" : null));
  const [error, setError] = useState<unknown>(null);
  const guard = useRef(false);

  // A reload, a crashed tablet or a dropped connection must not lose a sale: pick it up from the server.
  useEffect(() => {
    const saved = load<SavedSale>(SAVED);
    if (!saved) return;
    let live = true;
    (async () => {
      try {
        const [c, l0] = await Promise.all([api.cart(saved.cartId), api.customer(saved.phone)]);
        if (!live) return;
        // A sale started from the customer's profile is made to the prescription staff picked there, not whichever is newest.
        let l = l0;
        if (c.selectedRxId) {
          try {
            const picked = await api.prescription(c.customer.id, c.selectedRxId);
            l = { ...l0, prescription: { status: "valid", rx: picked.rx, warnings: picked.warnings, skipped: [] } };
          } catch { /* keep the default view; the server still bills the selected one */ }
        }
        if (!live) return;
        setCart(c);
        setLookup(l);
        setPhone(saved.phone);
        if (c.status !== "open") {
          try { if (live) setBill(await api.cartBill(c.id)); } catch (e) { if (live) setError(e); }
        }
      } catch (e) {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) save(SAVED, null);
        else setError(e);
      } finally {
        if (live) setBusy(null);
      }
    })();
    return () => { live = false; };
  }, []);

  const reset = useCallback(() => {
    save(SAVED, null);
    setCart(null); setBill(null); setLookup(null); setPhone(""); setError(null);
  }, []);

  async function doLookup() {
    if (guard.current || !phone.trim()) return;
    guard.current = true;
    setBusy("lookup");
    setError(null);
    setLookup(null);
    try {
      setLookup(await api.customer(phone.trim()));
    } catch (e) {
      setError(e);
    } finally {
      guard.current = false;
      setBusy(null);
    }
  }

  async function start() {
    if (guard.current || !lookup) return;
    guard.current = true;
    setBusy("start");
    setError(null);
    try {
      const c = await api.createCart({ phone: lookup.customer.phone, storeCode, channel });
      save(SAVED, { cartId: c.id, phone: lookup.customer.phone } satisfies SavedSale);
      setCart(c);
    } catch (e) {
      setError(e);
    } finally {
      guard.current = false;
      setBusy(null);
    }
  }

  // Edge: a bill exists -> show its state. Otherwise the sale builder. Otherwise the customer step.
  const onBill = useCallback((b: Bill) => setBill(b), []);
  const backToCart = useCallback(async () => {
    if (!cart) return;
    setBill(null);
    try { setCart(await api.cart(cart.id)); } catch (e) { setError(e); }
  }, [cart]);

  if (busy === "restore") return <div className="page"><Spinner label="Restoring your sale…" /></div>;

  if (cart && lookup && bill) {
    return (
      <div className="page">
        <h1>Sale · {cart.customer.name}</h1>
        <BillStatus bill={bill} onBill={onBill} onNewSale={reset} onBackToCart={backToCart} />
      </div>
    );
  }

  if (cart && lookup) {
    return (
      <div className="page">
        <div className="between">
          <div className="inline">
            <h1>New sale</h1>
            <Pill tone="neutral">{cart.storeCode}</Pill>
            <Pill tone="neutral">{CHANNELS.find((c) => c.value === cart.channel)?.label}</Pill>
            {lookup.flags.priority && <Pill tone="warn">Priority customer</Pill>}
            {lookup.flags.campaigns.map((c) => <Pill key={c} tone="info">Campaign: {c.replace(/_/g, " ")}</Pill>)}
          </div>
          <button onClick={() => { if (confirm("Abandon this sale and start over? The cart stays on the server but will not be shown here.")) reset(); }}>Abandon sale</button>
        </div>
        <ErrorBanner error={error} />
        <SaleBuilder cart={cart} lookup={lookup} onCart={setCart} onBill={onBill} />
      </div>
    );
  }

  const ready = !!storeCode;
  return (
    <div className="page">
      <h1>New sale</h1>
      {!ready && (stores?.length === 0
        ? <Banner tone="warn" title="No store assigned">Your account is not assigned to a store. Ask a manager.</Banner>
        : <Banner tone="info" title="Choose a store">Use the store selector at the top of the screen.</Banner>)}
      <Card title="Customer">
        <form className="inline" onSubmit={(e) => { e.preventDefault(); void doLookup(); }}>
          <div style={{ flex: "1 1 240px" }}><Field label="Customer mobile number"><input inputMode="tel" autoFocus placeholder="e.g. 9000000005" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field></div>
          <button className="primary" type="submit" disabled={!phone.trim() || busy === "lookup"} style={{ alignSelf: "flex-end" }}>{busy === "lookup" ? "Looking up…" : "Look up"}</button>
        </form>
        {error instanceof ApiError && error.code === "CUSTOMER_NOT_FOUND" && can("customer:create") ? (
          <Banner tone="info" title="No customer with that number" actions={<button className="primary" onClick={() => { setError(null); setCreating(true); }}>Create this customer</button>}>{error.message}</Banner>
        ) : (
          <ErrorBanner error={error} actions={error instanceof ApiError && error.outcomeUnknown ? <button onClick={doLookup}>Retry</button> : undefined} />
        )}
        {can("customer:create") && !creating && !lookup && <button className="link" style={{ justifySelf: "start" }} onClick={() => setCreating(true)}>New customer…</button>}
      </Card>

      {creating && (
        <NewCustomer
          initialPhone={phone}
          onCancel={() => setCreating(false)}
          onUseExisting={(p) => { setCreating(false); setPhone(p); void api.customer(p).then(setLookup).catch(setError); }}
          onCreated={(c) => { setCreating(false); setError(null); setPhone(c.customer.phone); setLookup(c); }}
        />
      )}

      {lookup && (
        <>
          <Card title={`${lookup.customer.firstName} ${lookup.customer.lastName}`} actions={<span className="mono muted">{lookup.customer.phone}</span>}>
            <div className="inline">
              {lookup.flags.priority && <Pill tone="warn">Priority customer</Pill>}
              {lookup.flags.family && <Pill tone="info">Family</Pill>}
              {lookup.flags.campaigns.map((c) => <Pill key={c} tone="info">Campaign: {c.replace(/_/g, " ")}</Pill>)}
              {!lookup.flags.priority && !lookup.flags.family && lookup.flags.campaigns.length === 0 && <span className="muted">No flags</span>}
            </div>
            <div className="small muted">{lookup.customer.ordersCount} previous order{lookup.customer.ordersCount === 1 ? "" : "s"} · lifetime spend {money(lookup.customer.lifetimeSpendPaise)}</div>
          </Card>
          <PrescriptionCard rx={lookup.prescription} />
          <Card title="Start the sale">
            <div className="fields">
              <Field label="Store"><input readOnly value={store ? `${store.name} (${store.code})` : storeCode} /></Field>
              <Field label="Billed by"><input readOnly value={user?.name ?? ""} /></Field>
              <Field label="Sales channel"><select value={channel} onChange={(e) => setChannel(e.target.value as Channel)}>{CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}</select></Field>
            </div>
            <button className="primary big" disabled={!ready || busy === "start"} onClick={start}>{busy === "start" ? "Starting…" : "Start sale"}</button>
          </Card>
        </>
      )}

      {ready && <Unfinished storeCode={storeCode} />}
    </div>
  );
}

/** Bills that were numbered or paid but never confirmed: the way back into an interrupted checkout. */
function Unfinished({ storeCode }: { storeCode: string }) {
  const [bills, setBills] = useState<BillSummary[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<Bill | null>(null);
  const [openErr, setOpenErr] = useState<unknown>(null);

  const reload = useCallback(() => {
    setError(null);
    api.recentBills(storeCode, 50).then((b) => setBills(b.filter((x) => x.status === "NUMBERED" || x.status === "CHARGED" || x.status === "CHARGED_NOT_POSTED"))).catch(setError);
  }, [storeCode]);
  useEffect(reload, [reload]);

  if (open) {
    return (
      <Card title="Unfinished bill" actions={<button onClick={() => { setOpen(null); reload(); }}>Close</button>}>
        <BillStatus bill={open} onBill={setOpen} onNewSale={() => { setOpen(null); reload(); }} onBackToCart={() => { setOpen(null); reload(); }} />
      </Card>
    );
  }
  return (
    <Card title="Unfinished bills at this store" actions={<button className="link" onClick={reload}>Refresh</button>}>
      <ErrorBanner error={error} actions={<button onClick={reload}>Retry</button>} />
      <ErrorBanner error={openErr} />
      {!bills && !error && <Spinner />}
      {bills && bills.length === 0 && <div className="muted">None. Every bill here is paid and confirmed, or was cancelled.</div>}
      {bills?.map((b) => (
        <button key={b.invoiceNo} className="list-btn" onClick={() => api.bill(b.invoiceNo).then(setOpen).catch(setOpenErr)}>
          <span><span className="mono">{b.invoiceNo}</span> · {b.customerName}<br /><span className="small muted">{dateTime(b.createdAt)} · {b.paymentMethod.toUpperCase()}</span></span>
          <span><Pill tone={b.status === "NUMBERED" ? "warn" : "info"}>{b.status.replace(/_/g, " ")}</Pill> {money(b.payablePaise)}</span>
        </button>
      ))}
    </Card>
  );
}
