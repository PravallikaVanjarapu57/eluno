import type { CustomerId } from "./customer.js";

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
