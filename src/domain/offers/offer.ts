import type { LensType } from "../catalog.js";
import type { Paise } from "../money.js";
import type { StaffRole } from "../store.js";

// Offer rules are data (config/offers.json); this is their shape inside the till.

export type OfferScope = "frame" | "lens" | "pair" | "cart";

export interface OfferCondition {
  minPairsInCart?: number;
  customerTag?: string;
  lensType?: LensType;
  indexMin?: number;
  coating?: string;
  hasFrameAndLens?: boolean;
}

export type OfferDiscount =
  | { type: "percent"; bps: number; on?: "lowest_priced_lens_line" }
  /** Value chosen at the till (manager discount), up to bpsMax. */
  | { type: "percent_manual"; bpsMax: number }
  | { type: "flat"; paise: Paise };

export interface Offer {
  id: string;
  name: string;
  active: boolean;
  validFrom: string;
  validTo: string;
  stackable: boolean;
  /** Lower applies first and wins ties. */
  priority: number;
  appliesTo: OfferScope;
  condition: OfferCondition;
  requires: { role?: StaffRole; reasonCode?: boolean };
  discount: OfferDiscount;
  /** Cap on this offer's total discount across the bill. */
  maxDiscountPaise?: Paise;
}

/** A manager's discretionary discount, already checked against staff and reason-code data. */
export interface ManualDiscount {
  offerId: string;
  bps: number;
  approverId: string;
  approverRole: StaffRole;
  approverCanOverride: boolean;
  reasonCode: string;
  requestedBy: string;
}

export interface ReasonCode {
  code: string;
  label: string;
}
