import type { Paise } from "./money.js";

// Sellable items as the till sees them. `variantId` is an opaque reference into the system of record.

export type LensType = "single_vision" | "bifocal" | "progressive";

export interface LensConfig {
  type: LensType;
  index: number;
  coating: string;
}

/** What the lab can make for this lens. Powers in dioptres. */
export interface RxLimits {
  sphMin: number;
  sphMax: number;
  cylAbsMax: number;
  addRequired: boolean;
  addMin: number;
  addMax: number;
}

interface ItemBase {
  variantId: string;
  sku: string;
  title: string;
  pricePaise: Paise; // MRP, GST inclusive
  hsn: string;
  sellable: boolean; // false for archived products: visible in history, not billable
}

export interface FrameItem extends ItemBase {
  kind: "frame";
  category: "optical" | "sunglasses";
  rxAble: boolean;
}

export interface LensItem extends ItemBase {
  kind: "lens";
  config: LensConfig;
  limits: RxLimits;
  labTatDays: number;
}

export type CatalogItem = FrameItem | LensItem;

export function describeLens(c: LensConfig): string {
  const type = { single_vision: "single vision", bifocal: "bifocal", progressive: "progressive" }[c.type];
  return `${type} ${c.index.toFixed(2)} ${c.coating.replace(/_/g, " ")}`;
}

export function lensConfigKey(c: LensConfig): string {
  return `${c.type}/${c.index}/${c.coating}`;
}
