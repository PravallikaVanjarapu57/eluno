import { buildBill, type Bill, type PaymentMethod } from "../domain/bill.js";
import { assertOpen, type Cart } from "../domain/cart.js";
import { DomainError } from "../domain/errors.js";
import { quoteCart } from "../domain/pricing.js";
import type { Offer } from "../domain/offers/offer.js";
import type { Store } from "../domain/store.js";
import type { TaxTable } from "../domain/tax.js";
import {
  OrderOutcomeUnknown,
  OrderRejected,
  type AuditLog,
  type BillRepository,
  type CartRepository,
  type Clock,
  type OrderSink,
  type PaymentTerminal,
  type StockLevels,
  type StoreDirectory,
} from "../ports/index.js";

export interface CheckoutDeps {
  carts: CartRepository;
  bills: BillRepository;
  stores: StoreDirectory;
  stock: StockLevels;
  terminal: PaymentTerminal;
  orders: OrderSink;
  audit: AuditLog;
  clock: Clock;
  offers: readonly Offer[];
  taxes: TaxTable;
  /** Times to try posting to Shopify before leaving the bill for the recovery sweep. */
  postAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/**
 * Cart -> invoice number -> payment -> Shopify order.
 * Each step is saved before the next external call, so any step can be resumed after a crash, a timeout
 * or a dropped connection without charging twice, numbering twice or creating a second Shopify order.
 */
export class Checkout {
  private readonly postAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (msg: string) => void;
  /** One driver per bill at a time; a second caller waits for the first and gets its result. */
  private readonly inflight = new Map<string, Promise<Bill>>();

  constructor(private readonly d: CheckoutDeps) {
    this.postAttempts = d.postAttempts ?? 3;
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.log = d.log ?? (() => {});
  }

  get(invoiceNo: string): Bill {
    const bill = this.d.bills.get(invoiceNo);
    if (!bill) throw new DomainError("BILL_NOT_FOUND", `No bill ${invoiceNo}.`, { invoiceNo });
    return bill;
  }

  async checkout(cartId: string, paymentMethod: PaymentMethod): Promise<Bill> {
    // Pressing "charge" twice (or a client retry after a timeout) resumes the same bill.
    const existing = this.d.bills.liveForCart(cartId);
    if (existing) return this.drive(existing);

    const cart = this.d.carts.get(cartId);
    if (!cart) throw new DomainError("CART_NOT_FOUND", `No cart ${cartId}.`, { cartId });
    assertOpen(cart);
    if (cart.pairs.length === 0) throw new DomainError("PAIR_EMPTY", "The cart is empty.");

    const today = this.d.clock.today();
    const store = await this.d.stores.getStore(cart.storeCode);
    if (!store || !store.active) throw new DomainError("STORE_NOT_FOUND", `${cart.storeCode} is not an active store.`);
    await this.recheck(cart, store, today);

    const quote = quoteCart(cart, this.d.offers, this.d.taxes, today);
    await this.ensureSeries(store);

    const now = this.d.clock.now().toISOString();
    let bill: Bill;
    try {
      bill = this.d.bills.createNumbered(store.code, store.invoicePrefix, (invoiceNo) => buildBill({ invoiceNo, cart, quote, store, paymentMethod, now }));
    } catch (e) {
      // A concurrent checkout of the same cart won the race (one live bill per cart is a DB constraint).
      const raced = this.d.bills.liveForCart(cartId);
      if (raced) return this.drive(raced);
      throw e;
    }
    this.d.carts.save({ ...cart, status: "checked_out", updatedAt: now });
    this.audit(bill, "bill.numbered", { payablePaise: bill.totals.payablePaise, offers: bill.appliedOffers.map((o) => o.offerId) });
    return this.drive(bill);
  }

  /** Continue a bill from wherever it stopped. */
  async resume(invoiceNo: string): Promise<Bill> {
    return this.drive(this.get(invoiceNo));
  }

  /** Abandon a bill that was never paid. The number stays in the series as cancelled; the cart reopens. */
  cancel(invoiceNo: string, staffId: string, reason: string): Bill {
    const bill = this.get(invoiceNo);
    if (bill.status !== "NUMBERED") {
      throw new DomainError("BILL_NOT_CANCELLABLE", `${invoiceNo} is ${bill.status}; only an unpaid bill can be cancelled. Use a refund instead.`, { status: bill.status });
    }
    return this.cancelBill(bill, reason, staffId);
  }

  /** Recovery sweep: finish posting bills that were paid but not yet in Shopify. Never charges anyone. */
  async resumePending(): Promise<Bill[]> {
    const pending = this.d.bills.listByStatus(["CHARGED", "CHARGED_NOT_POSTED"]);
    const out: Bill[] = [];
    for (const b of pending) out.push(await this.drive(b));
    return out;
  }

  private drive(bill: Bill): Promise<Bill> {
    const running = this.inflight.get(bill.invoiceNo);
    if (running) return running;
    const run = this.step(bill).finally(() => this.inflight.delete(bill.invoiceNo));
    this.inflight.set(bill.invoiceNo, run);
    return run;
  }

  private async step(bill: Bill): Promise<Bill> {
    // Re-read: another request may have moved this bill on since the caller loaded it.
    bill = this.d.bills.get(bill.invoiceNo) ?? bill;
    if (bill.status === "NUMBERED") bill = await this.pay(bill);
    if (bill.status === "CHARGED" || bill.status === "CHARGED_NOT_POSTED") bill = await this.post(bill);
    return bill;
  }

  private async pay(bill: Bill): Promise<Bill> {
    const amount = bill.totals.payablePaise;
    const at = this.d.clock.now().toISOString();
    if (amount === 0 || bill.paymentMethod === "cash") {
      // Cash goes in the drawer; a zero-value bill (e.g. a goodwill remake) has nothing to collect.
      return this.update(bill, { status: "CHARGED", payment: { method: bill.paymentMethod, amountPaise: amount, chargeId: null, at }, lastError: null }, "bill.paid");
    }
    const result = await this.d.terminal.charge({ orderRef: bill.invoiceNo, amountPaise: amount, method: bill.paymentMethod });
    switch (result.outcome) {
      case "captured":
        return this.update(bill, { status: "CHARGED", payment: { method: bill.paymentMethod, amountPaise: amount, chargeId: result.chargeId, at }, lastError: null }, "bill.paid", { chargeId: result.chargeId });
      case "declined":
        return this.cancelBill(bill, `Payment declined: ${result.reason}`, bill.staffId);
      case "unknown":
        // Do not cancel: the customer may have paid. Resuming retries with the same order_ref, which cannot double-charge.
        return this.update(bill, { lastError: `Payment status unknown: ${result.reason}` }, "bill.payment_unknown");
    }
  }

  private async post(bill: Bill): Promise<Bill> {
    for (let attempt = 1; attempt <= this.postAttempts; attempt++) {
      try {
        // After any earlier uncertain attempt, look before writing: the order may already exist.
        const found = bill.lastError ? await this.d.orders.findOrderByInvoiceNo(bill) : null;
        const posted = found ?? (await this.d.orders.createOrder(bill));
        return this.update(bill, { status: "POSTED", posted, lastError: null }, "bill.posted", { orderRef: posted.orderRef, orderName: posted.orderName, adopted: !!found });
      } catch (e) {
        if (e instanceof OrderRejected) {
          return this.update(bill, { status: "CHARGED_NOT_POSTED", lastError: e.message }, "bill.post_rejected");
        }
        const msg = e instanceof OrderOutcomeUnknown ? e.message : `Shopify unreachable: ${(e as Error).message}`;
        bill = this.update(bill, { status: "CHARGED_NOT_POSTED", lastError: msg }, "bill.post_failed", { attempt });
        this.log(`${bill.invoiceNo}: post attempt ${attempt} failed: ${msg}`);
        if (attempt < this.postAttempts) await this.sleep(500 * attempt);
      }
    }
    return bill;
  }

  private cancelBill(bill: Bill, reason: string, staffId: string): Bill {
    const at = this.d.clock.now().toISOString();
    const cancelled = this.update(bill, { status: "CANCELLED", cancelReason: reason }, "bill.cancelled", {}, staffId);
    const cart = this.d.carts.get(bill.cartId);
    if (cart) this.d.carts.save({ ...cart, status: "open", updatedAt: at });
    return cancelled;
  }

  /** Stock and prescriptions may have changed since items were added; check again before taking money. */
  private async recheck(cart: Cart, store: Store, today: string): Promise<void> {
    const frames = new Map<string, { count: number; frame: NonNullable<Cart["pairs"][number]["frame"]> }>();
    for (const p of cart.pairs) {
      if (p.frame) frames.set(p.frame.variantId, { count: (frames.get(p.frame.variantId)?.count ?? 0) + 1, frame: p.frame });
      if (p.lens && p.lens.rx.validUntil < today) {
        throw new DomainError("RX_NOT_IN_FORCE", `${p.lens.rx.rxId} expired on ${p.lens.rx.validUntil}. Book an eye test before billing a lens.`, { rxId: p.lens.rx.rxId });
      }
    }
    for (const { count, frame } of frames.values()) {
      const available = await this.d.stock.available(frame, store);
      if (available < count) {
        throw new DomainError("OUT_OF_STOCK", `${frame.sku} ${frame.title}: only ${available} left at ${store.code}, ${count} on this bill. Remove it or pick another frame.`, { sku: frame.sku, available, inCart: count });
      }
    }
  }

  private async ensureSeries(store: Store): Promise<void> {
    if (this.d.bills.hasSeries(store.code, "INV", store.invoicePrefix)) return;
    const last = await this.d.orders.maxInvoiceSeq(store, store.invoicePrefix);
    this.d.bills.initSeries(store.code, "INV", store.invoicePrefix, last + 1);
    this.log(`invoice series ${store.invoicePrefix} starts at ${last + 1} (continuing from Shopify)`);
  }

  private update(bill: Bill, patch: Partial<Bill>, action: string, payload: Record<string, unknown> = {}, staffId = bill.staffId): Bill {
    const at = this.d.clock.now().toISOString();
    const next = { ...bill, ...patch };
    this.d.bills.save(next, at);
    this.audit(next, action, { ...payload, ...(patch.lastError ? { error: patch.lastError } : {}) }, staffId);
    return next;
  }

  private audit(bill: Bill, action: string, payload: Record<string, unknown>, staffId = bill.staffId): void {
    this.d.audit.record({
      at: this.d.clock.now().toISOString(),
      staffId,
      action,
      ref: bill.invoiceNo,
      ...(bill.manualDiscount && action === "bill.numbered" ? { reasonCode: bill.manualDiscount.reasonCode, approverId: bill.manualDiscount.approverId } : {}),
      payload: { status: bill.status, ...payload },
    });
  }
}
