import type { ReactNode } from "react";
import type { Eye, RxStatus, RxSummary, RxView } from "../api/types";
import { dioptre } from "../lib/format";
import { Banner, Pill } from "./ui";

export function RxStatusPill({ status, validUntil }: { status: RxStatus; validUntil?: string }) {
  if (status === "valid") return <Pill tone="success">Valid{validUntil ? ` until ${validUntil}` : ""}</Pill>;
  if (status === "expired") return <Pill tone="error">Expired{validUntil ? ` ${validUntil}` : ""}</Pill>;
  return <Pill tone="warn">Future-dated</Pill>;
}

/** The list-row version: "No prescription" and "Unavailable" are states of the summary, not of a prescription. */
export function SummaryPill({ summary }: { summary: RxSummary | null }) {
  if (!summary) return <Pill tone="neutral">Unavailable</Pill>;
  if (!summary.latest) return <Pill tone="neutral">None on file</Pill>;
  return <RxStatusPill status={summary.latest.status} validUntil={summary.latest.validUntil} />;
}

function EyeRow({ name, eye }: { name: string; eye: Eye }) {
  return (
    <>
      <b>{name}</b>
      <span>{dioptre(eye.sph)}</span>
      <span>{dioptre(eye.cyl)}</span>
      <span>{eye.axis === null ? "—" : `${eye.axis}°`}</span>
      <span>{dioptre(eye.add)}</span>
    </>
  );
}

/** One prescription as the optical grid, with where it came from. `actions` is the select button in a sale. */
export function RxRecord({ view, actions, selected }: { view: RxView; actions?: ReactNode; selected?: boolean }) {
  const { rx } = view;
  return (
    <article className={`rx-record ${selected ? "selected" : ""} ${view.eligible ? "" : "ineligible"}`} aria-label={`Prescription ${rx.rxId}`}>
      <header className="between">
        <div className="inline">
          <strong className="mono">{rx.rxId}</strong>
          <RxStatusPill status={view.status} validUntil={rx.validUntil} />
          {selected && <Pill tone="info">Selected for this sale</Pill>}
        </div>
        {actions}
      </header>
      <div className="rx">
        <b />
        <b>SPH</b><b>CYL</b><b>AXIS</b><b>ADD</b>
        <EyeRow name="OD (right)" eye={rx.od} />
        <EyeRow name="OS (left)" eye={rx.os} />
      </div>
      <div className="small muted">
        Tested {rx.testedOn} · valid until {rx.validUntil} · {rx.source === "external" ? "External prescription" : "In-store test"}
        {rx.pd.binocular !== null && ` · PD ${rx.pd.binocular}`}
        {rx.notes && ` · ${rx.notes}`}
      </div>
      {view.reason && <Banner tone={view.status === "expired" ? "error" : "warn"}>{view.reason}</Banner>}
      {view.eligible && view.warnings.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
    </article>
  );
}
