import type { ReactNode } from "react";
import { ApiError } from "../api/client";

export type Tone = "error" | "warn" | "info" | "success" | "neutral";

export function Banner({ tone, title, children, actions }: { tone: Tone; title?: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <div className="banner-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
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
  return <span className="spinner" role="status"><i aria-hidden /> {label}</span>;
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
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

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small className="muted">{hint}</small>}
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
