import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { Cart, CustomerView, RxView } from "../api/types";
import { RxRecord } from "../components/RxParts";
import { BackLink, Banner, Card, ConfirmDialog, ErrorBanner, PageHead, Spinner } from "../components/ui";
import { load, save } from "../lib/storage";
import { useAuth } from "../state/auth";
import { useSession } from "../state/session";

/** What the till page restores after a reload: the cart, and who it is for. */
export interface SavedSale { cartId: string; phone: string; customerId?: string }
export const SAVED = "eluno.sale";

type Phase =
  | { kind: "loading" }
  | { kind: "busy"; saved: SavedSale; cart: Cart } // a different, unfinished sale is already open on this till
  | { kind: "ready"; cart: Cart };

/**
 * Start (or pick up) a sale for the customer being viewed. The cart is kept on the server and remembered on this device,
 * so going off to add a prescription and coming back finds the same cart, with nothing to look up again.
 */
export default function StartSalePage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const notice = (useLocation().state as { notice?: string } | null)?.notice;
  const { can } = useAuth();
  const { storeCode, store } = useSession();
  const [customer, setCustomer] = useState<CustomerView | null>(null);
  const [rx, setRx] = useState<RxView[] | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const started = useRef(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const start = useCallback(async (view: CustomerView) => {
    const saved = load<SavedSale>(SAVED);
    if (saved) {
      try {
        const cart = await api.cart(saved.cartId);
        if (cart.status === "open" && saved.customerId === view.customer.id && cart.customer.id === view.customer.id) return setPhase({ kind: "ready", cart });
        if (cart.status === "open" && cart.pairs.length > 0) return setPhase({ kind: "busy", saved, cart });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
    }
    const cart = await api.createCart({ customerId: view.customer.id, storeCode, channel: "walk_in" });
    save(SAVED, { cartId: cart.id, phone: view.customer.phone, customerId: view.customer.id } satisfies SavedSale);
    setPhase({ kind: "ready", cart });
  }, [storeCode]);

  const boot = useCallback(async () => {
    setError(null);
    setPhase({ kind: "loading" });
    try {
      const [view, list] = await Promise.all([api.customerById(id), api.eligiblePrescriptions(id).catch((e: unknown) => { setError(e); return null; })]);
      setCustomer(view);
      setRx(list);
      await start(view);
    } catch (e) {
      setError(e);
    }
  }, [id, start]);

  useEffect(() => {
    if (!storeCode || started.current) return;
    started.current = true; // StrictMode runs effects twice in development; one cart is enough
    void boot();
  }, [storeCode, boot]);

  const cart = phase.kind === "ready" ? phase.cart : null;
  const eligible = (rx ?? []).filter((v) => v.eligible);

  // One prescription in force: nothing to choose between, so use it. Several: wait for the salesperson.
  const auto = useRef(false);
  useEffect(() => {
    if (!cart || auto.current || cart.selectedRxId || eligible.length !== 1) return;
    auto.current = true;
    void choose(eligible[0]!.rx.rxId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart?.id, eligible.length]);

  async function choose(rxId: string | null) {
    if (!cart || saving) return;
    setSaving(rxId ?? "none");
    setError(null);
    try {
      setPhase({ kind: "ready", cart: await api.selectCartPrescription(cart.id, rxId) });
    } catch (e) {
      setError(e);
    } finally {
      setSaving(null);
    }
  }

  async function replaceSale() {
    if (!customer) return;
    setConfirmReplace(false);
    save(SAVED, null);
    started.current = true;
    setError(null);
    try { await start(customer); } catch (e) { setError(e); }
  }

  if (!can("billing:use")) return <div className="page"><Banner tone="warn" title="Your role cannot bill" /></div>;
  if (!storeCode) return <div className="page"><BackLink to={`/customers/${id}`}>Customer</BackLink><Banner tone="info" title="Choose a store">Select your store at the top of the screen to start a sale.</Banner></div>;

  const name = customer?.name ?? "customer";
  const selected = cart?.selectedRxId ?? null;
  const canContinue = !!cart && (selected !== null || eligible.length === 0);

  return (
    <div className="page">
      <BackLink to={`/customers/${id}`}>{name}</BackLink>
      <PageHead title={`Start sale · ${name}`} sub={store?.name} />
      <ConfirmDialog open={confirmReplace} title="Abandon the other sale?" confirmLabel="Abandon and start this one" tone="danger" onCancel={() => setConfirmReplace(false)} onConfirm={() => void replaceSale()}>
        The other cart stays on the server but will not be shown on this till again.
      </ConfirmDialog>
      {notice && <Banner tone="success">{notice}</Banner>}
      <ErrorBanner error={error} actions={<button onClick={() => { started.current = true; void boot(); }}>Retry</button>} />
      {phase.kind === "loading" && !error && <Spinner label="Preparing the sale…" />}

      {phase.kind === "busy" && (
        <Banner tone="warn" title={`A sale for ${phase.cart.customer.name} is still open on this till`} actions={
          <>
            <button className="primary" onClick={() => nav("/")}>Resume that sale</button>
            <button onClick={() => setConfirmReplace(true)}>Abandon it and start this one</button>
          </>
        }>It has {phase.cart.pairs.length} item{phase.cart.pairs.length === 1 ? "" : "s"} in it. Finish or abandon it before starting another.</Banner>
      )}

      {cart && (
        <Card title="Which prescription is this sale made to?" actions={can("prescription:create") ? <button onClick={() => nav(`/customers/${id}/prescriptions/new?returnTo=sale`)}>Add prescription</button> : undefined}>
          {rx === null && !error && <Spinner />}
          {rx && rx.length === 0 && <Banner tone="info" title="No prescription on file">Add one to bill lenses. You will come back to this sale. Frames and plain sunglasses can be billed without one.</Banner>}
          {rx && rx.length > 0 && eligible.length === 0 && <Banner tone="error" title="No prescription in force">Every prescription has expired or is future-dated, so lenses cannot be billed. Add a new prescription or book an eye test; frames can still be billed.</Banner>}
          {eligible.length > 1 && !selected && <Banner tone="warn" title="Choose one">{eligible.length} prescriptions are in force. Pick the one this sale is made to.</Banner>}
          <div className="stack" role="radiogroup" aria-label="Prescriptions">
            {rx?.map((v) => (
              <RxRecord
                key={v.rx.rxId}
                view={v}
                selected={selected === v.rx.rxId}
                actions={v.eligible
                  ? <button className={selected === v.rx.rxId ? "" : "primary"} role="radio" aria-checked={selected === v.rx.rxId} disabled={!!saving} onClick={() => void choose(v.rx.rxId)}>{selected === v.rx.rxId ? "Selected ✓" : saving === v.rx.rxId ? "Selecting…" : "Use this prescription"}</button>
                  : <span className="muted small">Cannot be used</span>}
              />
            ))}
          </div>
        </Card>
      )}

      {cart && (
        <div className="inline">
          <button className="primary big" disabled={!canContinue} onClick={() => nav("/")}>{selected ? "Continue to frames and lenses" : "Continue without a prescription"}</button>
          {!canContinue && <span className="muted">Choose a prescription to continue.</span>}
        </div>
      )}
    </div>
  );
}
