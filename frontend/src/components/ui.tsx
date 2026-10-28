import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { AlertTriangle, ArrowLeft, CheckCircle2, CircleAlert, Info, Loader2, XCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { ApiError } from "../api/client";

export type Tone = "error" | "warn" | "info" | "success" | "neutral";

/** Meaning is carried by the icon and the words, never by colour alone. */
export function ToneIcon({ tone, size = 18 }: { tone: Tone; size?: number }) {
  const p = { size, className: "icon", "aria-hidden": true } as const;
  return tone === "error" ? <XCircle {...p} /> : tone === "warn" ? <AlertTriangle {...p} /> : tone === "success" ? <CheckCircle2 {...p} /> : tone === "info" ? <Info {...p} /> : <CircleAlert {...p} />;
}

export function Banner({ tone, title, children, actions }: { tone: Tone; title?: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="banner-lead">
        <ToneIcon tone={tone} />
        <div className="banner-body">
          {title && <strong>{title}</strong>}
          {children && <div>{children}</div>}
        </div>
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}

interface Issue { message?: string }

/** A staff-facing API error: the server's own message, plus the per-eye issues of a lens mismatch. */
export function ErrorBanner({ error, title, actions }: { error: unknown; title?: string; actions?: ReactNode }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError(0, "UNKNOWN", (error as Error).message ?? "Something went wrong.");
  const d = (e.details ?? {}) as { issues?: Issue[]; suggestion?: string };
  const issues = Array.isArray(d.issues) ? d.issues.filter((i) => i.message) : [];
  return (
    <Banner tone="error" title={title ?? (e.status === 0 ? "Connection problem" : "Could not do that")} actions={actions}>
      {issues.length > 1 ? (
        <>
          <ul className="issues">{issues.map((i, n) => <li key={n}>{i.message}</li>)}</ul>
          {d.suggestion && <p className="suggestion">{d.suggestion}</p>}
        </>
      ) : (
        e.message
      )}
      <div className="muted small">{e.code}{e.status ? ` · HTTP ${e.status}` : ""}</div>
    </Banner>
  );
}

export function Spinner({ label = "Loading…" }: { label?: string }) {
  return <span className="spinner" role="status"><Loader2 size={16} className="icon" aria-hidden /> {label}</span>;
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}><ToneIcon tone={tone} size={13} />{children}</span>;
}

export function Card({ title, actions, children, className = "" }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | undefined; children: ReactNode }) {
  const id = useId();
  const note = error ?? hint;
  // The message is tied to the control, so a screen reader reads "invalid: <message>" with the field.
  const only = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<{ "aria-describedby"?: string }>) : null;
  return (
    <label className="field">
      <span>{label}</span>
      {only ? cloneElement(only, note ? { "aria-describedby": id } : {}) : children}
      {note && (error ? <small id={id} className="field-error" role="alert">{error}</small> : <small id={id} className="muted">{hint}</small>)}
    </label>
  );
}

export function Row({ k, v, strong }: { k: ReactNode; v: ReactNode; strong?: boolean }) {
  return (
    <div className={`row ${strong ? "row-strong" : ""}`}>
      <span>{k}</span>
      <span className="num">{v}</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, actions }: { icon?: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children && <div>{children}</div>}
      {actions}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="back" to={to}><ArrowLeft size={16} className="icon" aria-hidden />{children}</Link>;
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div><h1>{title}</h1>{sub && <p>{sub}</p>}</div>
      {actions && <div className="inline">{actions}</div>}
    </div>
  );
}

/** A modal on the browser's own <dialog>: focus moves in and is trapped, Escape closes it, and focus returns to what opened it. */
export function ConfirmDialog({ open, title, children, confirmLabel, tone = "primary", busy, onConfirm, onCancel }: {
  open: boolean; title: string; children: ReactNode; confirmLabel: string; tone?: "primary" | "danger"; busy?: boolean; onConfirm(): void; onCancel(): void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) (d.showModal ? d.showModal() : d.setAttribute("open", ""));
    if (!open && d.open) (d.close ? d.close() : d.removeAttribute("open"));
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" aria-labelledby="dlg-title" onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      {open && (
        <>
          <div className="dialog-body">
            <h2 id="dlg-title">{title}</h2>
            <div className="muted">{children}</div>
          </div>
          <div className="dialog-actions">
            <button onClick={onCancel} autoFocus>Cancel</button>
            <button className={tone} onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button>
          </div>
        </>
      )}
    </dialog>
  );
}

interface ToastItem { id: number; tone: Tone; text: string }
const ToastCtx = createContext<{ push(tone: Tone, text: string): void } | null>(null);
export const useToast = () => useContext(ToastCtx) ?? { push: () => undefined };

/** Short confirmations ("Saved") that disappear on their own; anything that needs a decision stays a Banner. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((tone: Tone, text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, tone, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5000);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts no-print" aria-live="polite">{items.map((t) => <div key={t.id} className="toast"><Banner tone={t.tone}>{t.text}</Banner></div>)}</div>
    </ToastCtx.Provider>
  );
}
