import { describeLens, type LensItem, type LensType } from "./catalog.js";
import type { EyeRx, Prescription } from "./prescription.js";

// Clinical gate: a lens the lab cannot make for this prescription must never reach the lab.

export type LensIssueCode = "SPH_OUT_OF_RANGE" | "CYL_OUT_OF_RANGE" | "ADD_MISSING" | "ADD_OUT_OF_RANGE";

export interface LensIssue {
  code: LensIssueCode;
  eye: "od" | "os";
  field: "sph" | "cyl" | "add";
  value: number | null;
  message: string;
}

const EYE_LABEL = { od: "Right eye (OD)", os: "Left eye (OS)" } as const;

export function formatDioptre(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}${Math.abs(v).toFixed(2)}`;
}

export function validateLensForRx(lens: LensItem, rx: Prescription): LensIssue[] {
  const { limits: l } = lens;
  const name = describeLens(lens.config);
  const issues: LensIssue[] = [];
  for (const eye of ["od", "os"] as const) {
    const e: EyeRx = rx[eye];
    const who = EYE_LABEL[eye];
    if (e.sph < l.sphMin || e.sph > l.sphMax) {
      issues.push({
        code: "SPH_OUT_OF_RANGE", eye, field: "sph", value: e.sph,
        message: `${who} SPH ${formatDioptre(e.sph)} is outside the ${name} range (${formatDioptre(l.sphMin)} to ${formatDioptre(l.sphMax)}).`,
      });
    }
    if (Math.abs(e.cyl) > l.cylAbsMax) {
      issues.push({
        code: "CYL_OUT_OF_RANGE", eye, field: "cyl", value: e.cyl,
        message: `${who} CYL ${formatDioptre(e.cyl)} exceeds the ${name} limit (±${l.cylAbsMax.toFixed(2)}).`,
      });
    }
    if (l.addRequired) {
      if (e.add === null) {
        issues.push({
          code: "ADD_MISSING", eye, field: "add", value: null,
          message: `${who} has no ADD on ${rx.rxId}; a ${lens.config.type} lens needs one. Ask the optometrist to record the ADD, or choose single vision.`,
        });
      } else if (e.add < l.addMin || e.add > l.addMax) {
        issues.push({
          code: "ADD_OUT_OF_RANGE", eye, field: "add", value: e.add,
          message: `${who} ADD ${formatDioptre(e.add)} is outside the ${name} range (${formatDioptre(l.addMin)} to ${formatDioptre(l.addMax)}).`,
        });
      }
    }
  }
  return issues;
}

export interface LensOption {
  lens: LensItem;
  valid: boolean;
  issues: LensIssue[];
}

export function lensOptionsFor(lenses: readonly LensItem[], rx: Prescription): LensOption[] {
  return lenses
    .filter((l) => l.sellable)
    .map((lens) => {
      const issues = validateLensForRx(lens, rx);
      return { lens, valid: issues.length === 0, issues };
    })
    .sort((a, b) => a.lens.config.type.localeCompare(b.lens.config.type) || a.lens.config.index - b.lens.config.index || a.lens.pricePaise - b.lens.pricePaise);
}

/** The actionable half of a rejection: which indexes of the same lens type would work for this Rx. */
export function suggestAlternatives(lenses: readonly LensItem[], rx: Prescription, wanted: LensItem): string {
  const sameType = (t: LensType) => lensOptionsFor(lenses, rx).filter((o) => o.valid && o.lens.config.type === t);
  const indexes = [...new Set(sameType(wanted.config.type).map((o) => o.lens.config.index))].sort((a, b) => a - b);
  if (indexes.length > 0) return `Choose index ${indexes.map((i) => i.toFixed(2)).join(", ")} for ${wanted.config.type.replace("_", " ")}.`;
  const otherTypes = [...new Set(lensOptionsFor(lenses, rx).filter((o) => o.valid).map((o) => o.lens.config.type))];
  if (otherTypes.length > 0) return `No ${wanted.config.type.replace("_", " ")} lens fits this prescription; available: ${otherTypes.join(", ").replace(/_/g, " ")}.`;
  return "No lens in the catalogue fits this prescription; refer to the optometrist for a special order.";
}
