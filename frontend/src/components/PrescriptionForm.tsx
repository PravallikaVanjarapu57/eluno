import { useRef, useState } from "react";
import { api } from "../api/endpoints";
import { ApiError } from "../api/client";
import type { EyeEntry, RxView } from "../api/types";
import { newRef } from "../lib/useLoad";
import { todayIST } from "../lib/format";
import { Banner, Card, ErrorBanner, Field } from "./ui";

type EyeText = { sph: string; cyl: string; axis: string; add: string };
const blank: EyeText = { sph: "", cyl: "", axis: "", add: "" };

const onGrid = (n: number) => Number.isInteger(n * 4);
const parse = (s: string): number | null => (s.trim() === "" ? null : Number(s.trim().replace(/^\+/, "")));

/** Quick checks so the obvious slips show up under the field before a round trip. The server applies the real rules and its messages are shown too. */
function localErrors(key: "od" | "os", e: EyeText): Record<string, string> {
  const out: Record<string, string> = {};
  const sph = parse(e.sph);
  const cyl = parse(e.cyl);
  const axis = parse(e.axis);
  const add = parse(e.add);
  if (sph === null) out[`${key}.sph`] = "SPH is required (0 for plano).";
  else if (Number.isNaN(sph) || !onGrid(sph)) out[`${key}.sph`] = "SPH must be a number in steps of 0.25.";
  if (cyl !== null && (Number.isNaN(cyl) || !onGrid(cyl))) out[`${key}.cyl`] = "CYL must be a number in steps of 0.25.";
  if (axis !== null && (Number.isNaN(axis) || !Number.isInteger(axis) || axis < 0 || axis > 180)) out[`${key}.axis`] = "AXIS is a whole number from 0 to 180.";
  else if (cyl !== null && !Number.isNaN(cyl) && cyl !== 0 && axis === null) out[`${key}.axis`] = "AXIS is required when there is a cylinder.";
  else if ((cyl === null || cyl === 0) && axis !== null) out[`${key}.axis`] = "Remove the AXIS: there is no cylinder.";
  if (add !== null && (Number.isNaN(add) || !onGrid(add))) out[`${key}.add`] = "ADD must be a number in steps of 0.25.";
  return out;
}

const toEntry = (e: EyeText): EyeEntry => {
  const sph = parse(e.sph);
  return { ...(sph === null ? {} : { sph }), cyl: parse(e.cyl) ?? 0, axis: parse(e.axis), add: parse(e.add) };
};

function EyeFields({ eyeKey, title, value, onChange, errors, touched }: { eyeKey: "od" | "os"; title: string; value: EyeText; onChange(v: EyeText): void; errors: Record<string, string>; touched: boolean }) {
  const set = (k: keyof EyeText) => (ev: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: ev.target.value });
  const err = (k: keyof EyeText) => errors[`${eyeKey}.${k}`];
  const cell = (k: keyof EyeText, label: string, hint: string) => (
    <Field label={`${label}`} error={(touched ? err(k) : undefined) ?? errors[`server.${eyeKey}.${k}`]}>
      <input aria-label={`${title} ${label}`} inputMode="decimal" placeholder={hint} value={value[k]} onChange={set(k)} aria-invalid={!!(touched && err(k))} />
    </Field>
  );
  return (
    <Card title={title}>
      <div className="rx-fields">
        {cell("sph", "SPH", "-2.25")}
        {cell("cyl", "CYL", "-0.75")}
        {cell("axis", "AXIS", "90")}
        {cell("add", "ADD", "+1.50")}
      </div>
    </Card>
  );
}

/**
 * A prescription form on its own page. Saving always adds a new record; older prescriptions are never edited or replaced.
 * The expiry date is optional: left empty, the server dates it one year after the test, like every prescription in the store tool.
 */
export function PrescriptionForm({ customerId, customerName, onSaved, onCancel }: {
  customerId: string;
  customerName: string;
  onSaved(rx: RxView): void;
  onCancel(): void;
}) {
  const today = todayIST();
  const [testedOn, setTestedOn] = useState(today);
  const [validUntil, setValidUntil] = useState("");
  const [od, setOd] = useState<EyeText>(blank);
  const [os, setOs] = useState<EyeText>(blank);
  const [pd, setPd] = useState("");
  const [notes, setNotes] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inflight = useRef(false);
  // One reference per form: a second tap or a deliberate retry after a lost answer cannot store the prescription twice.
  const clientRef = useRef(newRef());

  const errors: Record<string, string> = { ...localErrors("od", od), ...localErrors("os", os) };
  const pdN = parse(pd);
  if (!testedOn) errors.testedOn = "Test date is required.";
  else if (testedOn > today) errors.testedOn = "The test date cannot be in the future.";
  if (validUntil && testedOn && validUntil < testedOn) errors.validUntil = "The expiry date cannot be before the test date.";
  if (pdN !== null && (Number.isNaN(pdN) || pdN < 40 || pdN > 80)) errors.pd = "PD must be between 40 and 80 mm, or empty.";

  const serverMsgs = ((error instanceof ApiError ? (error.details as { fields?: Record<string, string> } | undefined)?.fields : undefined) ?? {}) as Record<string, string>;
  const withServer: Record<string, string> = { ...errors };
  for (const [k, v] of Object.entries(serverMsgs)) withServer[`server.${k}`] = v;
  const fieldMsg = (k: string) => (touched ? errors[k] : undefined) ?? serverMsgs[k === "pd" ? "pd.binocular" : k];
  const e = error instanceof ApiError ? error : null;

  async function submit() {
    setTouched(true);
    if (inflight.current || Object.keys(errors).length > 0) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.addPrescription(customerId, {
        clientRef: clientRef.current,
        testedOn,
        ...(validUntil ? { validUntil } : {}),
        od: toEntry(od),
        os: toEntry(os),
        pd: { binocular: pdN },
        notes: notes.trim() || null,
      }));
    } catch (err) {
      setError(err);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="stack" noValidate onSubmit={(ev) => { ev.preventDefault(); void submit(); }} aria-label={`New prescription for ${customerName}`}>
      <Card title="Test details">
        <div className="fields">
          <Field label="Test date *" error={fieldMsg("testedOn")}>
            <input type="date" max={today} value={testedOn} onChange={(ev) => setTestedOn(ev.target.value)} aria-invalid={!!fieldMsg("testedOn")} />
          </Field>
          <Field label="Valid until" hint="Leave empty for one year after the test." error={fieldMsg("validUntil")}>
            <input type="date" min={testedOn || undefined} value={validUntil} onChange={(ev) => setValidUntil(ev.target.value)} aria-invalid={!!fieldMsg("validUntil")} />
          </Field>
          <Field label="PD (mm)" hint="Optional" error={fieldMsg("pd")}>
            <input inputMode="decimal" placeholder="62" value={pd} onChange={(ev) => setPd(ev.target.value)} aria-invalid={!!fieldMsg("pd")} />
          </Field>
        </div>
      </Card>

      <EyeFields eyeKey="od" title="Right eye (OD)" value={od} onChange={setOd} errors={withServer} touched={touched} />
      <EyeFields eyeKey="os" title="Left eye (OS)" value={os} onChange={setOs} errors={withServer} touched={touched} />

      <Card title="Notes">
        <Field label="Prescribed by, remarks" hint="Optional, up to 500 characters. Entered prescriptions are recorded as external: confirm with the optometrist." error={fieldMsg("notes")}>
          <textarea rows={3} maxLength={500} value={notes} onChange={(ev) => setNotes(ev.target.value)} />
        </Field>
      </Card>

      {touched && Object.keys(errors).length > 0 && <Banner tone="warn" title="Please correct the highlighted fields">The prescription has not been saved.</Banner>}
      {e?.code === "RX_INVALID" ? <Banner tone="error" title="The prescription needs correcting">{e.message}</Banner>
        : e?.outcomeUnknown ? <Banner tone="warn" title="Could not confirm the prescription was saved">{e.message} Check the customer's prescription list before saving again. Saving again from this form will not create a duplicate.</Banner>
        : <ErrorBanner error={error} />}

      <div className="inline">
        <button className="primary big" type="submit" disabled={busy}>{busy ? "Saving…" : "Save prescription"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
