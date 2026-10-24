import { randomUUID } from "node:crypto";
import { addPair, assertOpen, removePair, type Cart, type LensLine } from "../domain/cart.js";
import type { FrameItem, LensItem } from "../domain/catalog.js";
import { DomainError } from "../domain/errors.js";
import { lensOptionsFor, suggestAlternatives, validateLensForRx, type LensOption } from "../domain/lens.js";
import { normalizeIndianMobile } from "../domain/phone.js";
import { buildManualDiscount } from "../domain/offers/manual.js";
import type { Offer, ReasonCode } from "../domain/offers/offer.js";
import { selectPrescription, type Prescription } from "../domain/prescription.js";
import { quoteCart, type Quote } from "../domain/pricing.js";
import type { TaxTable } from "../domain/tax.js";
import type { Channel, Store } from "../domain/store.js";
import type { AuditLog, Catalog, CartRepository, Clock, PrescriptionSource, StaffDirectory, StockLevels, StoreDirectory } from "../ports/index.js";
import type { LookupCustomer } from "./lookupCustomer.js";

export interface CreateCartInput {
  phone: string;
  storeCode: string;
  staffId: string;
  channel: Channel;
}

export interface AddPairInput {
  frameVariantId?: string;
  lensVariantId?: string;
  /** Defaults to the prescription currently in force. */
  rxId?: string;
}

export interface ManagerDiscountInput {
  approverId: string;
  reasonCode: string;
  bps: number;
}

export class Carts {
  constructor(
    private readonly deps: {
      lookup: LookupCustomer;
      prescriptions: PrescriptionSource;
      catalog: Catalog;
      stock: StockLevels;
      stores: StoreDirectory;
      staff: StaffDirectory;
      carts: CartRepository;
      audit: AuditLog;
      clock: Clock;
      offers: readonly Offer[];
      taxes: TaxTable;
      discountReasons: readonly ReasonCode[];
    },
  ) {}

  async create(input: CreateCartInput): Promise<Cart> {
    const [store, { customer }] = await Promise.all([this.store(input.storeCode), this.deps.lookup.byPhone(input.phone)]);
    const staff = (await this.deps.staff.listByStore(store.code)).find((s) => s.staffId === input.staffId);
    if (!staff) throw new DomainError("STAFF_NOT_AT_STORE", `Staff ${input.staffId} is not on the ${store.code} roster.`, { staffId: input.staffId, storeCode: store.code });

    const now = this.deps.clock.now().toISOString();
    const cart: Cart = {
      id: randomUUID(),
      storeCode: store.code,
      staffId: staff.staffId,
      channel: input.channel,
      customer,
      pairs: [],
      manualDiscount: null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    };
    this.deps.carts.save(cart);
    return cart;
  }

  get(cartId: string): Cart {
    const cart = this.deps.carts.get(cartId);
    if (!cart) throw new DomainError("CART_NOT_FOUND", `No cart ${cartId}.`, { cartId });
    return cart;
  }

  async addPair(cartId: string, input: AddPairInput): Promise<Cart> {
    const cart = this.get(cartId);
    assertOpen(cart);
    const today = this.deps.clock.today();

    const [frame, lensItem] = await Promise.all([
      input.frameVariantId ? this.item(input.frameVariantId, "frame") : null,
      input.lensVariantId ? this.item(input.lensVariantId, "lens") : null,
    ]);

    let lens: LensLine | null = null;
    let lensIssues: ReturnType<typeof validateLensForRx> = [];
    let lensAlternatives: string | undefined;
    if (lensItem) {
      const rx = await this.prescription(cart, input.rxId, today);
      lens = { item: lensItem, rx };
      lensIssues = validateLensForRx(lensItem, rx);
      if (lensIssues.length > 0) lensAlternatives = suggestAlternatives(await this.deps.catalog.listLenses(), rx, lensItem);
    } else if (input.rxId) {
      throw new DomainError("RX_REQUIRED", "A prescription was given without a lens. Add a lens, or drop the prescription.");
    }

    const frameStock = frame ? await this.deps.stock.available(frame, await this.store(cart.storeCode)) : null;
    const updated = addPair(cart, { frame, lens, frameStock, lensIssues, today, ...(lensAlternatives ? { lensAlternatives } : {}) }, this.deps.clock.now().toISOString());
    this.deps.carts.save(updated);
    return updated;
  }

  removePair(cartId: string, pairRef: string): Cart {
    const updated = removePair(this.get(cartId), pairRef, this.deps.clock.now().toISOString());
    this.deps.carts.save(updated);
    return updated;
  }

  quote(cartId: string): Quote {
    return quoteCart(this.get(cartId), this.deps.offers, this.deps.taxes, this.deps.clock.today());
  }

  async setManagerDiscount(cartId: string, input: ManagerDiscountInput): Promise<Cart> {
    const cart = this.get(cartId);
    assertOpen(cart);
    const roster = await this.deps.staff.listByStore(cart.storeCode);
    const manual = buildManualDiscount({
      offer: this.deps.offers.find((o) => o.discount.type === "percent_manual"),
      approver: roster.find((s) => s.staffId === input.approverId),
      approverId: input.approverId,
      storeCode: cart.storeCode,
      reasonCode: input.reasonCode,
      reasonCodes: this.deps.discountReasons,
      bps: input.bps,
      requestedBy: cart.staffId,
    });
    const at = this.deps.clock.now().toISOString();
    const updated: Cart = { ...cart, manualDiscount: manual, updatedAt: at };
    this.deps.carts.save(updated);
    this.deps.audit.record({ at, staffId: cart.staffId, action: "manager_discount.set", ref: `cart:${cart.id}`, reasonCode: manual.reasonCode, approverId: manual.approverId, payload: { bps: manual.bps } });
    return updated;
  }

  clearManagerDiscount(cartId: string): Cart {
    const cart = this.get(cartId);
    assertOpen(cart);
    const at = this.deps.clock.now().toISOString();
    const updated: Cart = { ...cart, manualDiscount: null, updatedAt: at };
    this.deps.carts.save(updated);
    if (cart.manualDiscount) this.deps.audit.record({ at, staffId: cart.staffId, action: "manager_discount.cleared", ref: `cart:${cart.id}` });
    return updated;
  }

  /** Every lens in the matrix, marked valid or invalid (with reasons) for this customer's prescription. */
  async lensOptions(phone: string, rxId?: string): Promise<{ rx: Prescription; options: LensOption[] }> {
    const { customer } = await this.deps.lookup.byPhone(phone);
    const rx = await this.prescriptionFor(customer.id, normalizeIndianMobile(phone), rxId, this.deps.clock.today());
    return { rx, options: lensOptionsFor(await this.deps.catalog.listLenses(), rx) };
  }

  private async store(code: string): Promise<Store> {
    const store = await this.deps.stores.getStore(code);
    if (!store || !store.active) throw new DomainError("STORE_NOT_FOUND", `${code} is not an active store.`, { storeCode: code });
    return store;
  }

  private async item(variantId: string, kind: "frame"): Promise<FrameItem>;
  private async item(variantId: string, kind: "lens"): Promise<LensItem>;
  private async item(variantId: string, kind: "frame" | "lens"): Promise<FrameItem | LensItem> {
    const item = await this.deps.catalog.getItem(variantId);
    if (!item) throw new DomainError("ITEM_NOT_FOUND", `No product with variant ${variantId}.`, { variantId });
    if (item.kind !== kind) throw new DomainError("WRONG_ITEM_TYPE", `${item.sku} is a ${item.kind}, not a ${kind}.`, { variantId, sku: item.sku });
    return item;
  }

  private prescription(cart: Cart, rxId: string | undefined, today: string): Promise<Prescription> {
    return this.prescriptionFor(cart.customer.id, cart.customer.phone, rxId, today);
  }

  private async prescriptionFor(customerId: string, phone: string, rxId: string | undefined, today: string): Promise<Prescription> {
    let all: Prescription[];
    try {
      all = await this.deps.prescriptions.listByPhone(phone);
    } catch {
      throw new DomainError("RX_UNAVAILABLE", "Store tool is not responding; lens billing needs the prescription. Try again shortly.");
    }
    if (rxId) {
      const rx = all.find((r) => r.rxId === rxId && r.customerId === customerId);
      if (!rx) throw new DomainError("RX_NOT_FOUND", `No prescription ${rxId} for this customer.`, { rxId });
      return rx; // in-force check happens in the domain (addPair) so the message is the same everywhere
    }
    const sel = selectPrescription(customerId, all, today);
    if (sel.status === "valid") return sel.rx;
    throw new DomainError("RX_NOT_IN_FORCE", sel.reason, { status: sel.status });
  }
}
