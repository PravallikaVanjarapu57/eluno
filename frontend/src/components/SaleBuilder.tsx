import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import { PAYMENT_METHODS, type Bill, type Cart, type CustomerLookup, type Frame, type LensMatrix, type LensOption, type PaymentMethod, type Quote } from "../api/types";
import { label, money, ratePct } from "../lib/format";
import { useAuth } from "../state/auth";
import { useSession } from "../state/session";
import { PrescriptionCard } from "./PrescriptionCard";
import { Banner, Card, ErrorBanner, Field, Pill, Spinner } from "./ui";

/** Frames and lenses -> pairs in the cart -> server quote (offers + GST) -> manager discount -> charge. */
export function SaleBuilder({ cart, lookup, onCart, onBill }: {
  cart: Cart;
  lookup: CustomerLookup;
  onCart(c: Cart): void;
  onBill(b: Bill): void;
}) {
  return (
    <div className="grid-2">
      <div className="stack">
        {cart.rxSelection === "explicit" && (
          cart.selectedRxId
            ? <div className="small"><Link to={`/customers/${cart.customer.id}/sale`}>Change prescription</Link></div>
            : lookup.prescription.status === "valid" && <Banner tone="warn" title="Choose the prescription" actions={<Link className="btn primary" to={`/customers/${cart.customer.id}/sale`}>Choose prescription</Link>}>Lenses are made to a prescription you pick on the customer's sale page.</Banner>
        )}
        <PrescriptionCard rx={lookup.prescription} />
        <ItemPicker cart={cart} lookup={lookup} onCart={onCart} />
      </div>
      <div className="stack">
        <CartAndQuote cart={cart} onCart={onCart} onBill={onBill} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------- items

function ItemPicker({ cart, lookup, onCart }: { cart: Cart; lookup: CustomerLookup; onCart(c: Cart): void }) {
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [framesErr, setFramesErr] = useState<unknown>(null);
  const [matrix, setMatrix] = useState<LensMatrix | null>(null);
  const [matrixErr, setMatrixErr] = useState<unknown>(null);
  const [search, setSearch] = useState("");
  const [onlyValid, setOnlyValid] = useState(false);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [lens, setLens] = useState<LensOption | null>(null);
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState<unknown>(null);
  const guard = useRef(false);

  const loadFrames = useCallback(() => {
    setFramesErr(null);
    setFrames(null);
    api.frames(cart.storeCode).then(setFrames).catch(setFramesErr);
  }, [cart.storeCode]);
  useEffect(loadFrames, [loadFrames]);

  const rxStatus = lookup.prescription.status;
  const loadLenses = useCallback(() => {
    if (rxStatus !== "valid") return;
    if (cart.rxSelection === "explicit" && !cart.selectedRxId) return; // nothing chosen yet: do not guess which prescription to match
    setMatrixErr(null);
    setMatrix(null);
    api.lenses(lookup.customer.phone, cart.selectedRxId).then(setMatrix).catch(setMatrixErr);
  }, [lookup.customer.phone, rxStatus, cart.rxSelection, cart.selectedRxId]);
  useEffect(loadLenses, [loadLenses]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (frames ?? []).filter((f) => !q || f.title.toLowerCase().includes(q) || f.sku.toLowerCase().includes(q) || f.category.includes(q));
  }, [frames, search]);

  async function add() {
    if (guard.current || (!frame && !lens)) return;
    guard.current = true;
    setAdding(true);
    setAddErr(null);
    try {
      const body: { frameVariantId?: string; lensVariantId?: string } = {};
      if (frame) body.frameVariantId = frame.variantId;
      if (lens) body.lensVariantId = lens.variantId;
      onCart(await api.addPair(cart.id, body));
      setFrame(null);
      setLens(null);
      loadFrames(); // stock at this store has changed
    } catch (e) {
      setAddErr(e);
      // If the answer was lost the pair may or may not have been added: show the cart as the server has it.
      if (e instanceof ApiError && e.outcomeUnknown) api.cart(cart.id).then(onCart).catch(() => {});
    } finally {
      guard.current = false;
      setAdding(false);
    }
  }

  const inCart = (f: Frame) => cart.pairs.filter((p) => p.frame?.variantId === f.variantId).length;

  return (
    <>
      <Card title="1 · Frame" actions={<button className="link" onClick={loadFrames}>Refresh stock</button>}>
        <input placeholder="Search frames (name, SKU, sunglasses…)" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search frames" />
        <ErrorBanner error={framesErr} actions={<button onClick={loadFrames}>Retry</button>} />
        {!frames && !framesErr && <Spinner label="Loading frames…" />}
        <div className="picker">
          {shown.map((f) => {
            const left = f.available - inCart(f);
            return (
              <button key={f.variantId} className={`item ${frame?.variantId === f.variantId ? "selected" : ""}`} disabled={left <= 0} onClick={() => setFrame(frame?.variantId === f.variantId ? null : f)}>
                <span>{f.title}</span>
                <span className="num">{money(f.pricePaise)}</span>
                <small className="muted">
                  {f.sku} · {label(f.category)}{!f.rxAble && " · not for prescription lenses"} ·{" "}
                  {left <= 0 ? <b style={{ color: "var(--err)" }}>Out of stock at {cart.storeCode}</b> : `${left} in stock at ${cart.storeCode}`}
                </small>
              </button>
            );
          })}
          {frames && shown.length === 0 && <div className="muted">No frames match.</div>}
        </div>
      </Card>

      <Card title="2 · Lens" actions={matrix && <label className="inline small"><input type="checkbox" style={{ width: 20, minHeight: 20 }} checked={onlyValid} onChange={(e) => setOnlyValid(e.target.checked)} /> Valid only</label>}>
        {rxStatus !== "valid" ? (
          <Banner tone="warn" title="No lens can be billed">
            {lookup.prescription.status === "expired" ? lookup.prescription.reason : lookup.prescription.status === "none_on_file" || lookup.prescription.status === "unavailable" ? lookup.prescription.reason : ""} You can still sell the frame on its own.
          </Banner>
        ) : (
          <>
            <div className="small muted">Checked against {matrix?.rxId ?? "the prescription"}. The server validates every lens again when you add it.</div>
            <ErrorBanner error={matrixErr} actions={<button onClick={loadLenses}>Retry</button>} />
            {!matrix && !matrixErr && <Spinner label="Checking lenses against the prescription…" />}
            <div className="picker">
              {(matrix?.options ?? []).filter((o) => !onlyValid || o.valid).map((o) => (
                <button key={o.variantId} className={`item ${lens?.variantId === o.variantId ? "selected" : ""} ${o.valid ? "" : "invalid"}`}
                  onClick={() => setLens(lens?.variantId === o.variantId ? null : o)} aria-disabled={!o.valid} disabled={!o.valid}>
                  <span>{o.valid ? "✓" : "✗"} {label(o.description)}</span>
                  <span className="num">{money(o.pricePaise)}</span>
                  <small className="muted">{o.sku} · lab {o.labTatDays} day{o.labTatDays === 1 ? "" : "s"}</small>
                  {!o.valid && o.reasons.map((r, i) => <small key={i} style={{ color: "var(--err)" }}>{r}</small>)}
                </button>
              ))}
            </div>
          </>
        )}
      </Card>

      <Card title="3 · Add to cart">
        <div className="small">
          <div><b>Frame:</b> {frame ? `${frame.title} · ${money(frame.pricePaise)}` : <span className="muted">none</span>}</div>
          <div><b>Lens:</b> {lens ? `${label(lens.description)} · ${money(lens.pricePaise)}` : <span className="muted">none</span>}</div>
        </div>
        <ErrorBanner error={addErr} />
        <button className="primary big" disabled={adding || (!frame && !lens)} onClick={add}>{adding ? "Adding…" : "Add pair to cart"}</button>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------------------------- cart + quote + payment

function CartAndQuote({ cart, onCart, onBill }: { cart: Cart; onCart(c: Cart): void; onBill(b: Bill): void }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [quoteErr, setQuoteErr] = useState<unknown>(null);
  const [loadingQuote, setLoadingQuote] = useState(false);
  const [cartErr, setCartErr] = useState<unknown>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  // Recompute whenever the cart changes. Offers, GST and totals all come from the server.
  const sig = JSON.stringify([cart.pairs.map((p) => [p.pairRef, p.frame?.variantId, p.lens?.variantId]), cart.manualDiscount]);
  const [reloadTick, setReloadTick] = useState(0);
  useEffect(() => {
    if (cart.pairs.length === 0) {
      setQuote(null);
      setQuoteErr(null);
      return;
    }
    let live = true;
    setLoadingQuote(true);
    setQuoteErr(null);
    api.quote(cart.id).then((q) => live && setQuote(q)).catch((e) => live && (setQuote(null), setQuoteErr(e))).finally(() => live && setLoadingQuote(false));
    return () => { live = false; };
  }, [cart.id, sig, reloadTick]);

  async function remove(pairRef: string) {
    if (removing) return;
    setRemoving(pairRef);
    setCartErr(null);
    try {
      onCart(await api.removePair(cart.id, pairRef));
    } catch (e) {
      setCartErr(e);
      api.cart(cart.id).then(onCart).catch(() => {});
    } finally {
      setRemoving(null);
    }
  }

  return (
    <>
      <Card title={`Cart · ${cart.customer.name}`} actions={<span className="muted small">{cart.pairs.length} pair{cart.pairs.length === 1 ? "" : "s"}</span>}>
        {cart.pairs.length === 0 && <div className="muted">Pick a frame and/or lens and add it. Offers and GST are calculated automatically.</div>}
        {cart.pairs.map((p) => (
          <div key={p.pairRef} className="between" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
            <div>
              <b>Pair {p.pairRef}</b>
              {p.frame && <div>{p.frame.title} <span className="muted small">{p.frame.sku} · {money(p.frame.pricePaise)}</span></div>}
              {p.lens && <div>{label(p.lens.description)} <span className="muted small">{p.lens.sku} · {money(p.lens.pricePaise)} · {p.lens.rxId} · lab {p.lens.labTatDays}d</span></div>}
            </div>
            <button onClick={() => remove(p.pairRef)} disabled={removing !== null} aria-label={`Remove pair ${p.pairRef}`}>{removing === p.pairRef ? "Removing…" : "Remove"}</button>
          </div>
        ))}
        <ErrorBanner error={cartErr} />
      </Card>

      {cart.pairs.length > 0 && (
        <>
          <QuoteView quote={quote} loading={loadingQuote} error={quoteErr} onRetry={() => setReloadTick((t) => t + 1)} />
          <ManagerDiscount cart={cart} onCart={onCart} />
          <Payment cart={cart} quote={quote} onBill={onBill} onCart={onCart} />
        </>
      )}
    </>
  );
}

function QuoteView({ quote, loading, error, onRetry }: { quote: Quote | null; loading: boolean; error: unknown; onRetry(): void }) {
  const [showAll, setShowAll] = useState(true);
  return (
    <Card title="Offers, GST and total" actions={loading ? <Spinner label="Recalculating…" /> : undefined}>
      <ErrorBanner error={error} title="Could not price this cart" actions={<button onClick={onRetry}>Retry</button>} />
      {quote && (
        <>
          <div className="scroll">
            <table className="quote">
              <thead><tr><th>Line</th><th className="num">MRP</th><th className="num">Disc.</th><th className="num">Taxable</th><th className="num">CGST</th><th className="num">SGST</th><th className="num">Total</th></tr></thead>
              <tbody>
                {quote.lines.map((l) => (
                  <tr key={l.lineId}>
                    <td>{l.pairRef} · {l.kind}<div className="small muted mono">{l.sku} · HSN {l.hsn} · GST {ratePct(l.rateBps)}</div></td>
                    <td className="num">{money(l.grossPaise)}</td>
                    <td className="num">{l.discountPaise ? `−${money(l.discountPaise)}` : "—"}</td>
                    <td className="num">{money(l.taxablePaise)}</td>
                    <td className="num">{money(l.cgstPaise)}</td>
                    <td className="num">{money(l.sgstPaise)}</td>
                    <td className="num">{money(l.netPaise)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><td>Total</td><td className="num">{money(quote.totals.grossPaise)}</td><td className="num">−{money(quote.totals.discountPaise)}</td><td className="num">{money(quote.totals.taxablePaise)}</td><td className="num">{money(quote.totals.cgstPaise)}</td><td className="num">{money(quote.totals.sgstPaise)}</td><td className="num">{money(quote.totals.payablePaise)}</td></tr>
              </tfoot>
            </table>
          </div>
          <div className="between"><span>Payable (incl. GST {money(quote.totals.taxPaise)})</span><span className="big-total num">{money(quote.totals.payablePaise)}</span></div>

          <div className="between"><b>Offers</b><button className="link" onClick={() => setShowAll((s) => !s)}>{showAll ? "Show applied only" : "Show all with reasons"}</button></div>
          <div className="stack">
            {quote.offerEvaluations.filter((o) => showAll || o.applied).map((o) => (
              <div key={o.offerId} className="between" style={{ alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Pill tone={o.applied ? "success" : "neutral"}>{o.applied ? "Applied" : "Not applied"}</Pill> <b>{o.name}</b>
                  <div className="small muted">{o.why}</div>
                </div>
                <span className="num">{o.applied ? `−${money(o.amountPaise)}` : ""}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function ManagerDiscount({ cart, onCart }: { cart: Cart; onCart(c: Cart): void }) {
  const { reasonCodes } = useSession();
  const { user, can } = useAuth();
  const [reason, setReason] = useState("");
  const [pct, setPct] = useState("5");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const guard = useRef(false);
  const code = reasonCodes?.discount.find((r) => r.code === cart.manualDiscount?.reasonCode);

  async function run(fn: () => Promise<Cart>) {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setErr(null);
    try {
      onCart(await fn());
    } catch (e) {
      setErr(e);
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  const value = Number(pct);
  const valid = reason && Number.isFinite(value) && value > 0 && value <= 10;

  return (
    <Card title="Manager discount" actions={cart.manualDiscount ? <Pill tone="info">Active</Pill> : undefined}>
      {cart.manualDiscount ? (
        <div className="between">
          <div>{cart.manualDiscount.bps / 100}% approved by <b>{cart.manualDiscount.approverId === user?.staffId ? user.name : cart.manualDiscount.approverId}</b> · {code?.label ?? cart.manualDiscount.reasonCode}
            <div className="small muted">It only takes effect if it beats the automatic offers (see the offer list above).</div></div>
          <button onClick={() => run(() => api.clearManagerDiscount(cart.id))} disabled={busy}>Remove</button>
        </div>
      ) : !can("discount:manager") ? (
        <div className="muted small">Only a store manager can give a discount. Ask the manager to sign in on this till and apply it; they approve it with their own login.</div>
      ) : (
        <>
          <div className="small muted">Up to 10%. You ({user?.name}) approve it, and a reason is recorded.</div>
          <div className="fields">
            <Field label="Reason"><select value={reason} onChange={(e) => setReason(e.target.value)}><option value="">Select reason…</option>{reasonCodes?.discount.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></Field>
            <Field label="Discount %"><input type="number" min={0.5} max={10} step={0.5} value={pct} onChange={(e) => setPct(e.target.value)} /></Field>
          </div>
          <button disabled={!valid || busy} onClick={() => run(() => api.setManagerDiscount(cart.id, { reasonCode: reason, bps: Math.round(value * 100) }))}>Apply manager discount</button>
        </>
      )}
      <ErrorBanner error={err} />
    </Card>
  );
}

function Payment({ cart, quote, onBill, onCart }: { cart: Cart; quote: Quote | null; onBill(b: Bill): void; onCart(c: Cart): void }) {
  const [method, setMethod] = useState<PaymentMethod>("upi");
  const [confirming, setConfirming] = useState(false);
  const [charging, setCharging] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [lost, setLost] = useState(false); // the answer to "charge" was lost; the bill's real state is unknown
  const [checking, setChecking] = useState(false);
  const [noBill, setNoBill] = useState(false);
  const inflight = useRef(false);

  /** Ask the server what became of this cart's checkout. A read, so it is always safe. */
  const reconcile = useCallback(async () => {
    setChecking(true);
    try {
      onBill(await api.cartBill(cart.id));
      setLost(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === "BILL_NOT_FOUND") {
        setLost(false);
        setNoBill(true); // the server never numbered a bill: nothing was charged
        api.cart(cart.id).then(onCart).catch(() => {});
      } else {
        setLost(true);
        setErr(e);
      }
    } finally {
      setChecking(false);
    }
  }, [cart.id, onBill, onCart]);

  async function charge() {
    if (inflight.current || !quote) return; // a double tap can never send two requests
    inflight.current = true;
    setCharging(true);
    setConfirming(false);
    setErr(null);
    setNoBill(false);
    setLost(false);
    try {
      const r = await api.checkout(cart.id, method);
      onBill(r.data); // 201 posted · 202 in progress · 402 declined: BillStatus renders each honestly
    } catch (e) {
      if (e instanceof ApiError && e.outcomeUnknown) {
        setErr(e);
        await reconcile();
      } else {
        setErr(e);
      }
    } finally {
      inflight.current = false;
      setCharging(false);
    }
  }

  return (
    <Card title="Payment">
      <div className="seg" role="radiogroup" aria-label="Payment method">
        {PAYMENT_METHODS.map((m) => (
          <button key={m} role="radio" aria-checked={method === m} className={method === m ? "on" : ""} disabled={charging} onClick={() => { setMethod(m); setConfirming(false); }}>
            {m === "upi" ? "UPI" : m === "card" ? "Card" : "Cash"}
          </button>
        ))}
      </div>

      {err != null && !lost && !noBill && <ErrorBanner error={err} />}
      {lost && (
        <Banner tone="warn" title="Could not confirm whether the payment went through"
          actions={<button className="primary" onClick={reconcile} disabled={checking}>{checking ? "Checking…" : "Check status"}</button>}>
          The connection dropped before the till answered. <b>Do not charge again yet.</b> Check status to see what the server recorded for this cart.
        </Banner>
      )}
      {noBill && <Banner tone="info" title="No bill was created">The server has no bill for this cart, so nothing was charged. You can charge again.</Banner>}

      {confirming ? (
        <Banner tone="warn" title={`Charge ${money(quote?.totals.payablePaise ?? 0)} by ${method.toUpperCase()}?`}
          actions={<><button className="primary" onClick={charge} disabled={charging}>Yes, charge</button><button onClick={() => setConfirming(false)}>Back</button></>}>
          {method === "cash" ? "Take the cash first; this records the sale." : "The terminal will prompt the customer. This takes the next invoice number."}
        </Banner>
      ) : (
        <button className="primary big" disabled={!quote || charging || lost || checking} onClick={() => setConfirming(true)}>
          {charging ? "Charging…" : quote ? `Charge ${money(quote.totals.payablePaise)}` : "Waiting for total…"}
        </button>
      )}
      {charging && <Spinner label="Waiting for the terminal and Shopify…" />}
    </Card>
  );
}
