import type { FrameItem, LensItem } from "./catalog.js";
import type { Customer } from "./customer.js";
import { DomainError } from "./errors.js";
import type { LensIssue } from "./lens.js";
import type { Paise } from "./money.js";
import type { ManualDiscount } from "./offers/offer.js";
import type { Prescription } from "./prescription.js";
import type { Channel } from "./store.js";

// A cart is a list of pairs. A pair is what one person wears: a frame and/or a lens made to a prescription.
// Frame only (sunglasses, frame-only sale), lens only (customer's own frame), or both.
// Prices are snapshotted when the pair is added, so the quote does not move under the customer.

export interface LensLine {
  item: LensItem;
  rx: Prescription;
}

export interface Pair {
  pairRef: string;
  frame: FrameItem | null;
  lens: LensLine | null;
}

export interface Cart {
  id: string;
  storeCode: string;
  staffId: string;
  channel: Channel;
  customer: Customer;
  pairs: Pair[];
  /** Manager's discretionary discount, if one was approved for this bill. */
  manualDiscount: ManualDiscount | null;
  /** The prescription staff picked for this sale; lenses are made to it unless a pair names another. */
  selectedRxId?: string | null;
  /** Set when the sale was started from a customer profile: with several prescriptions in force, staff must pick one. */
  rxSelection?: "explicit";
  status: "open" | "checked_out";
  createdAt: string;
  updatedAt: string;
}

export interface NewPair {
  frame: FrameItem | null;
  lens: LensLine | null;
  /** Units of this frame available at the billing store, as read just now. */
  frameStock: number | null;
  /** Result of validateLensForRx for `lens`, computed by the caller. */
  lensIssues: LensIssue[];
  /** Hint for staff when the lens is rejected, e.g. "Choose index 1.60, 1.67, 1.74". */
  lensAlternatives?: string;
  today: string;
}

export function assertOpen(cart: Cart): void {
  if (cart.status !== "open") throw new DomainError("CART_CLOSED", "This cart has already been billed. Start a new cart.", { cartId: cart.id });
}

export function addPair(cart: Cart, p: NewPair, now: string): Cart {
  assertOpen(cart);
  if (!p.frame && !p.lens) throw new DomainError("PAIR_EMPTY", "Add a frame, a lens, or both.");

  if (p.frame) {
    const f = p.frame;
    if (!f.sellable) throw new DomainError("ITEM_NOT_SELLABLE", `${f.sku} ${f.title} is archived and cannot be billed.`, { sku: f.sku });
    const alreadyInCart = cart.pairs.filter((x) => x.frame?.variantId === f.variantId).length;
    if (p.frameStock === null || p.frameStock < alreadyInCart + 1) {
      throw new DomainError(
        "OUT_OF_STOCK",
        `${f.sku} ${f.title}: ${p.frameStock ?? 0} in stock at ${cart.storeCode}${alreadyInCart ? `, ${alreadyInCart} already in this cart` : ""}. Pick another frame or arrange a transfer.`,
        { sku: f.sku, available: p.frameStock ?? 0, inCart: alreadyInCart },
      );
    }
    if (p.lens && !f.rxAble) {
      throw new DomainError("FRAME_NOT_RX_ABLE", `${f.sku} ${f.title} cannot take prescription lenses. Bill it frame-only, or choose an Rx-able frame.`, { sku: f.sku });
    }
  }

  if (p.lens) {
    const { item, rx } = p.lens;
    if (!item.sellable) throw new DomainError("ITEM_NOT_SELLABLE", `${item.sku} is not available for billing.`, { sku: item.sku });
    if (rx.customerId !== cart.customer.id) {
      throw new DomainError("RX_NOT_FOUND", `${rx.rxId} is not ${cart.customer.firstName}'s prescription. Family billing on one bill is not supported in v1.`, { rxId: rx.rxId });
    }
    if (rx.testedOn > p.today || rx.validUntil < p.today) {
      throw new DomainError(
        "RX_NOT_IN_FORCE",
        rx.validUntil < p.today
          ? `${rx.rxId} expired on ${rx.validUntil}. Book an eye test before billing a lens.`
          : `${rx.rxId} is dated ${rx.testedOn}, in the future. Check the store tool entry.`,
        { rxId: rx.rxId, testedOn: rx.testedOn, validUntil: rx.validUntil },
      );
    }
    if (p.lensIssues.length > 0) {
      throw new DomainError(
        "LENS_RX_MISMATCH",
        [...p.lensIssues.map((i) => i.message), p.lensAlternatives].filter(Boolean).join(" "),
        { sku: item.sku, rxId: rx.rxId, issues: p.lensIssues, ...(p.lensAlternatives ? { suggestion: p.lensAlternatives } : {}) },
      );
    }
  }

  const nextRef = String(Math.max(0, ...cart.pairs.map((x) => Number(x.pairRef))) + 1);
  return { ...cart, pairs: [...cart.pairs, { pairRef: nextRef, frame: p.frame, lens: p.lens }], updatedAt: now };
}

export function removePair(cart: Cart, pairRef: string, now: string): Cart {
  assertOpen(cart);
  if (!cart.pairs.some((x) => x.pairRef === pairRef)) throw new DomainError("PAIR_NOT_FOUND", `No pair ${pairRef} in this cart.`, { pairRef });
  return { ...cart, pairs: cart.pairs.filter((x) => x.pairRef !== pairRef), updatedAt: now };
}

/** MRP before offers and tax; pricing proper lives in the invoice. */
export function mrpTotal(cart: Cart): Paise {
  return cart.pairs.reduce((acc, x) => acc + (x.frame?.pricePaise ?? 0) + (x.lens?.item.pricePaise ?? 0), 0);
}
