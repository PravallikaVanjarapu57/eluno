import type { Eye, PrescriptionLookup } from "../api/types";
import { dioptre } from "../lib/format";
import { Banner, Card, Pill } from "./ui";

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

export function PrescriptionCard({ rx }: { rx: PrescriptionLookup }) {
  if (rx.status === "unavailable") {
    return <Banner tone="warn" title="Prescriptions unavailable">{rx.reason}</Banner>;
  }
  if (rx.status === "none_on_file") {
    return <Banner tone="warn" title="No prescription on file">{rx.reason} Frames and non-prescription sunglasses can still be billed.</Banner>;
  }
  const p = rx.status === "valid" ? rx.rx : rx.latest;
  return (
    <Card
      title={
        <>
          Prescription {p.rxId}{" "}
          {rx.status === "valid" ? <Pill tone="success">In force until {p.validUntil}</Pill> : <Pill tone="error">Expired {p.validUntil}</Pill>}
        </>
      }
    >
      {rx.status === "expired" && <Banner tone="error" title="Lens billing is blocked">{rx.reason}</Banner>}
      <div className="rx">
        <b />
        <b>SPH</b><b>CYL</b><b>AXIS</b><b>ADD</b>
        <EyeRow name="OD (right)" eye={p.od} />
        <EyeRow name="OS (left)" eye={p.os} />
      </div>
      <div className="small muted">
        Tested {p.testedOn} · {p.source === "external" ? "External Rx" : "In-store test"}
        {p.pd.binocular !== null && ` · PD ${p.pd.binocular}`}
        {p.notes && ` · ${p.notes}`}
      </div>
      {rx.status === "valid" && rx.warnings.map((w) => <Banner key={w} tone="warn">{w}</Banner>)}
      {rx.skipped.length > 0 && (
        <details className="small">
          <summary>{rx.skipped.length} other prescription(s) not used</summary>
          <ul>{rx.skipped.map((s) => <li key={s.rxId}><span className="mono">{s.rxId}</span>: {s.reason}</li>)}</ul>
        </details>
      )}
    </Card>
  );
}
