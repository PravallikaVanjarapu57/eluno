import type { CustomerId, FieldErrors } from "./customer.js";

// OD = right eye, OS = left eye. Powers are dioptres on the 0.25 D grid (exact in binary floating point).

export interface EyeRx {
  sph: number;
  cyl: number;
  axis: number | null;
  add: number | null;
}

export interface Prescription {
  rxId: string;
  customerId: CustomerId;
  testedOn: string; // YYYY-MM-DD
  validUntil: string; // YYYY-MM-DD, inclusive
  source: "in_store" | "external";
  optometristId: string | null;
  od: EyeRx;
  os: EyeRx;
  pd: { binocular: number | null; monoR: number | null; monoL: number | null };
  notes: string | null;
}

export type RxSelection =
  | { status: "valid"; rx: Prescription; warnings: string[]; skipped: SkippedRx[] }
  | { status: "expired"; latest: Prescription; reason: string; skipped: SkippedRx[] }
  | { status: "none_on_file"; reason: string; skipped: SkippedRx[] };

export interface SkippedRx {
  rxId: string;
  reason: string;
}

const EYES = [
  ["od", "right eye (OD)"],
  ["os", "left eye (OS)"],
] as const;

/**
 * The prescription to bill against on `today`: the most recent test that is in force,
 * i.e. tested on or before today and valid until today or later. Upstream order is not trusted.
 */
export function selectPrescription(customerId: CustomerId, all: readonly Prescription[], today: string): RxSelection {
  const skipped: SkippedRx[] = [];
  const mine: Prescription[] = [];
  for (const rx of all) {
    if (rx.customerId !== customerId) skipped.push({ rxId: rx.rxId, reason: "belongs to another customer on this phone" });
    else if (rx.testedOn > today) skipped.push({ rxId: rx.rxId, reason: `test date ${rx.testedOn} is in the future; check the store tool entry` });
    else mine.push(rx);
  }
  mine.sort((a, b) => b.testedOn.localeCompare(a.testedOn) || b.rxId.localeCompare(a.rxId));

  const valid = mine.find((rx) => rx.validUntil >= today);
  if (valid) {
    for (const rx of mine) if (rx !== valid) skipped.push({ rxId: rx.rxId, reason: rx.validUntil < today ? `expired ${rx.validUntil}` : `superseded by ${valid.rxId}` });
    return { status: "valid", rx: valid, warnings: warningsFor(valid), skipped };
  }
  const latest = mine[0];
  if (latest) {
    for (const rx of mine.slice(1)) skipped.push({ rxId: rx.rxId, reason: `expired ${rx.validUntil}` });
    return { status: "expired", latest, reason: `Latest prescription ${latest.rxId} expired on ${latest.validUntil}. Book an eye test before billing a lens.`, skipped };
  }
  return { status: "none_on_file", reason: "No prescription on file. Book an eye test, or enter the external prescription in the store tool.", skipped };
}

/** Things staff should double-check before billing, without blocking. */
export function warningsFor(rx: Prescription): string[] {
  const warnings: string[] = [];
  if (rx.source === "external") warnings.push(`${rx.rxId} is an external prescription; confirm it with the optometrist.`);
  for (const [key, label] of EYES) {
    const axis = rx[key].axis;
    if (axis !== null && axis % 5 !== 0) {
      warnings.push(`${label} axis ${axis}° is not on the 5° grid; have the optometrist confirm before ordering.`);
    }
  }
  return warnings;
}

// ------------------------------------------------------------------------------------------------ status

/** Where a prescription stands on a given day. Same rule selectPrescription and addPair apply: tested on or before today, valid until today or later. */
export type RxStatus = "valid" | "expired" | "future_dated";

export function rxStatus(rx: Pick<Prescription, "testedOn" | "validUntil">, today: string): RxStatus {
  if (rx.testedOn > today) return "future_dated";
  return rx.validUntil >= today ? "valid" : "expired";
}

/** Newest test first, ties by id, whatever order upstream sent. */
export const newestFirst = (a: Prescription, b: Prescription): number => b.testedOn.localeCompare(a.testedOn) || b.rxId.localeCompare(a.rxId);

// ------------------------------------------------------------------------------------------------ entry

export interface EyeInput {
  sph?: number;
  cyl?: number;
  axis?: number | null;
  add?: number | null;
}

export interface NewPrescriptionInput {
  testedOn: string;
  /** Defaults to one year after the test, which is how every prescription in the store tool is dated. */
  validUntil?: string;
  od: EyeInput;
  os: EyeInput;
  pd?: { binocular?: number | null; monoR?: number | null; monoL?: number | null };
  notes?: string | null;
}

/** What the store tool is asked to store. Staff-entered prescriptions are always `external`: in-store tests come from the optometrist's own system. */
export type NewPrescription = Omit<Prescription, "rxId" | "source" | "optometristId"> & { source: "external"; optometristId: null };

export const RX_LIMITS = { sph: [-20, 20], cyl: [-8, 8], add: [0.25, 4], pdBinocular: [40, 80], pdMono: [20, 40], maxValidityDays: 730, defaultValidityDays: 365 } as const;

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const onGrid = (v: number) => Number.isInteger(v * 4);

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const isRealDate = (s: string) => ISO.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

/**
 * Check a prescription typed by staff and turn it into what is stored. Every rule is the one the rest of the till already relies on
 * (0.25 D grid, axis 0-180, ADD needed for progressives, validity as dates) plus plain clinical bounds. A message per field, never a silent fix.
 */
export function checkNewPrescription(customerId: CustomerId, input: NewPrescriptionInput, today: string): { ok: true; value: NewPrescription } | { ok: false; fields: FieldErrors } {
  const fields: FieldErrors = {};

  const testedOn = input.testedOn ?? "";
  if (!isRealDate(testedOn)) fields.testedOn = "Enter the test date as YYYY-MM-DD.";
  else if (testedOn > today) fields.testedOn = `The test date ${testedOn} is in the future.`;

  let validUntil = input.validUntil ?? "";
  if (!validUntil && isRealDate(testedOn)) validUntil = addDays(testedOn, RX_LIMITS.defaultValidityDays);
  if (!isRealDate(validUntil)) fields.validUntil = "Enter the expiry date as YYYY-MM-DD.";
  else if (isRealDate(testedOn)) {
    if (validUntil < testedOn) fields.validUntil = "The expiry date cannot be before the test date.";
    else if (validUntil > addDays(testedOn, RX_LIMITS.maxValidityDays)) fields.validUntil = `A prescription cannot be valid for more than ${RX_LIMITS.maxValidityDays / 365} years from the test.`;
  }

  const eyes: Record<"od" | "os", EyeRx> = { od: { sph: 0, cyl: 0, axis: null, add: null }, os: { sph: 0, cyl: 0, axis: null, add: null } };
  for (const [key, label] of [["od", "Right eye (OD)"], ["os", "Left eye (OS)"]] as const) {
    const e = input[key] ?? {};
    const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
    if (!num(e.sph)) fields[`${key}.sph`] = `${label}: SPH is required (enter 0 for plano).`;
    else if (!onGrid(e.sph)) fields[`${key}.sph`] = `${label}: SPH must be in steps of 0.25.`;
    else if (e.sph < RX_LIMITS.sph[0] || e.sph > RX_LIMITS.sph[1]) fields[`${key}.sph`] = `${label}: SPH must be between ${RX_LIMITS.sph[0]} and +${RX_LIMITS.sph[1]}.`;

    const cyl = e.cyl ?? 0;
    if (!num(cyl)) fields[`${key}.cyl`] = `${label}: CYL must be a number.`;
    else if (!onGrid(cyl)) fields[`${key}.cyl`] = `${label}: CYL must be in steps of 0.25.`;
    else if (cyl < RX_LIMITS.cyl[0] || cyl > RX_LIMITS.cyl[1]) fields[`${key}.cyl`] = `${label}: CYL must be between ${RX_LIMITS.cyl[0]} and +${RX_LIMITS.cyl[1]}.`;

    const axis = e.axis ?? null;
    if (axis !== null && (!num(axis) || !Number.isInteger(axis) || axis < 0 || axis > 180)) fields[`${key}.axis`] = `${label}: AXIS must be a whole number from 0 to 180.`;
    else if (num(cyl) && cyl !== 0 && axis === null) fields[`${key}.axis`] = `${label}: AXIS is required when there is a cylinder.`;
    else if (num(cyl) && cyl === 0 && axis !== null) fields[`${key}.axis`] = `${label}: remove the AXIS, there is no cylinder.`;

    const add = e.add ?? null;
    if (add !== null && (!num(add) || !onGrid(add) || add < RX_LIMITS.add[0] || add > RX_LIMITS.add[1])) fields[`${key}.add`] = `${label}: ADD must be from ${RX_LIMITS.add[0]} to ${RX_LIMITS.add[1]} in steps of 0.25, or empty.`;

    if (num(e.sph) && num(cyl)) eyes[key] = { sph: e.sph, cyl, axis: axis !== null && num(axis) ? axis : null, add: add !== null && num(add) ? add : null };
  }

  const pdIn = input.pd ?? {};
  const pdVal = (v: number | null | undefined, [lo, hi]: readonly [number, number], key: string, label: string): number | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) fields[key] = `${label} must be between ${lo} and ${hi} mm, or empty.`;
    return typeof v === "number" ? v : null;
  };
  const pd = {
    binocular: pdVal(pdIn.binocular, RX_LIMITS.pdBinocular, "pd.binocular", "PD"),
    monoR: pdVal(pdIn.monoR, RX_LIMITS.pdMono, "pd.monoR", "Right PD"),
    monoL: pdVal(pdIn.monoL, RX_LIMITS.pdMono, "pd.monoL", "Left PD"),
  };

  const notes = (input.notes ?? "").trim();
  if (notes.length > 500) fields.notes = "Notes are too long (500 characters at most).";

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return { ok: true, value: { customerId, testedOn, validUntil, source: "external", optometristId: null, od: eyes.od, os: eyes.os, pd, notes: notes || null } };
}
