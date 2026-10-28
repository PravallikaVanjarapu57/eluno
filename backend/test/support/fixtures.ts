import type { Cart } from "../../src/domain/cart.js";
import type { FrameItem, LensItem, LensType } from "../../src/domain/catalog.js";
import type { Customer } from "../../src/domain/customer.js";
import type { EyeRx, Prescription } from "../../src/domain/prescription.js";

export const TODAY = "2026-10-23";

export const customer = (over: Partial<Customer> = {}): Customer => ({
  id: "C1", firstName: "Asha", lastName: "K", phone: "+919000000001", tags: [], lifetimeSpendPaise: 0, ordersCount: 0, ...over,
});

export const eye = (sph: number, cyl = 0, add: number | null = null, axis: number | null = cyl ? 90 : null): EyeRx => ({ sph, cyl, axis, add });

export const rx = (over: Partial<Prescription> = {}): Prescription => ({
  rxId: "RX1", customerId: "C1", testedOn: "2026-06-01", validUntil: "2027-06-01", source: "in_store", optometristId: "S107",
  od: eye(-2), os: eye(-2), pd: { binocular: 62, monoR: null, monoL: null }, notes: null, ...over,
});

export const frame = (over: Partial<FrameItem> = {}): FrameItem => ({
  kind: "frame", variantId: "91000003", sku: "FR-0003", title: "Atelier Rectangle 03 Tortoise", pricePaise: 1099800, hsn: "90031900",
  sellable: true, category: "optical", rxAble: true, ...over,
});

const LIMITS = {
  1.5: { sphMin: -4, sphMax: 4, cylAbsMax: 2 },
  1.56: { sphMin: -4, sphMax: 4, cylAbsMax: 2 },
  1.6: { sphMin: -8, sphMax: 6, cylAbsMax: 4 },
  1.67: { sphMin: -10, sphMax: 8, cylAbsMax: 4 },
  1.74: { sphMin: -14, sphMax: 10, cylAbsMax: 6 },
} as const;

/** Mirrors the seed lens matrix: limits by index, ADD required for bifocal/progressive. */
export const lens = (type: LensType, index: keyof typeof LIMITS, coating = "standard", over: Partial<LensItem> = {}): LensItem => ({
  kind: "lens", variantId: `L-${type}-${index}-${coating}`, sku: `LN-${type}-${index}`, title: `${type} ${index}`, pricePaise: 499900,
  hsn: "90015000", sellable: true, config: { type, index, coating },
  limits: { ...LIMITS[index], addRequired: type !== "single_vision", addMin: 0.75, addMax: 3 }, labTatDays: 5, ...over,
});

export const matrix = (): LensItem[] =>
  (["single_vision", "bifocal", "progressive"] as const).flatMap((t) =>
    ([1.5, 1.56, 1.6, 1.67, 1.74] as const).filter((i) => !(t === "bifocal" && i > 1.6)).map((i) => lens(t, i)),
  );

export const cart = (over: Partial<Cart> = {}): Cart => ({
  id: "cart-1", storeCode: "HSR", staffId: "S105", channel: "walk_in", customer: customer(), pairs: [], manualDiscount: null, status: "open",
  createdAt: "2026-10-23T10:00:00.000Z", updatedAt: "2026-10-23T10:00:00.000Z", ...over,
});
