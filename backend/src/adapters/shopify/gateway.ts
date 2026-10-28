import type { CatalogItem, FrameItem, LensItem } from "../../domain/catalog.js";
import type { Customer } from "../../domain/customer.js";
import type { Store } from "../../domain/store.js";
import type { Bill, PostedOrder } from "../../domain/bill.js";
import { parseInvoiceSeq } from "../../domain/bill.js";
import { CustomerAlreadyExists, CustomerOutcomeUnknown, CustomerRejected, OrderOutcomeUnknown, OrderRejected, type Catalog, type CustomerDirectory, type CustomerRegistry, type FrameListing, type NewCustomer, type OrderSink, type SalesLedger, type StockLevels, type StoreDirectory, type StoreListing } from "../../ports/index.js";
import { AmbiguousWriteError, HttpError, parseUpstream, RetriesExhaustedError, type HttpClient } from "../http/client.js";
import type { CreditNote } from "../../domain/refund.js";
import type { Paise } from "../../domain/money.js";
import { fromShopifyMoney } from "./money.js";
import type { LedgerOrder } from "../../domain/dayEnd.js";
import { noteAttr, toLedgerOrder, toPostedOrder, toRefundCalculate, toShopifyOrder, toShopifyRefund } from "./orderMapper.js";
import { toCatalogItem, toCustomer, toStore } from "./mapper.js";
import {
  CustomerResponseSchema,
  CustomerSearchResponseSchema,
  InventoryLevelsResponseSchema,
  LocationsResponseSchema,
  OrderResponseSchema,
  OrdersResponseSchema,
  OrderWithRefundsSchema,
  RefundCalculateResponseSchema,
  RefundResponseSchema,
  ProductResponseSchema,
  ProductsResponseSchema,
  VariantResponseSchema,
} from "./schemas.js";

/** Short-lived memo so a busy till does not re-read the catalogue on every scan. */
class Memo<T> {
  private value: { at: number; data: T } | null = null;
  constructor(private readonly ttlMs: number) {}
  async get(load: () => Promise<T>): Promise<T> {
    if (this.value && Date.now() - this.value.at < this.ttlMs) return this.value.data;
    const data = await load();
    this.value = { at: Date.now(), data };
    return data;
  }
}

/** Shopify Admin REST adapter. The only place in the codebase that knows Shopify's shapes. */
export class ShopifyGateway implements CustomerDirectory, CustomerRegistry, Catalog, StockLevels, StoreDirectory, StoreListing, FrameListing, OrderSink, SalesLedger {
  private readonly lenses = new Memo<LensItem[]>(5 * 60_000);
  private readonly locations = new Memo<Store[]>(10 * 60_000);
  private readonly frames = new Memo<{ item: CatalogItem; inventoryItemId: number | null }[]>(5 * 60_000);
  // Stock is keyed by inventory item, which the domain does not know about; remember it per variant.
  private readonly inventoryItemOf = new Map<string, number | null>();

  constructor(private readonly http: HttpClient) {}

  async findByPhone(phone: string): Promise<Customer[]> {
    const res = await this.http.get("customers/search.json", { query: `phone:${phone}` });
    const { customers } = parseUpstream("shopify", "customer search", CustomerSearchResponseSchema, res.body);
    // Search is fuzzy in real Shopify; keep exact matches only.
    return customers.filter((c) => c.phone === phone).map(toCustomer);
  }

  async getItem(variantId: string): Promise<CatalogItem | null> {
    if (!/^\d+$/.test(variantId)) return null;
    let variant;
    try {
      variant = parseUpstream("shopify", "variant", VariantResponseSchema, (await this.http.get(`variants/${variantId}.json`)).body).variant;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
    // Product status (archived) lives on the product, not the variant.
    const { product } = parseUpstream("shopify", "product", ProductResponseSchema, (await this.http.get(`products/${variant.product_id}.json`)).body);
    this.inventoryItemOf.set(variantId, variant.inventory_item_id);
    return toCatalogItem(product, variant);
  }

  listLenses(): Promise<LensItem[]> {
    return this.lenses.get(async () => {
      const res = await this.http.get("products.json", { product_type: "Lens", limit: 250 });
      const { products } = parseUpstream("shopify", "product list", ProductsResponseSchema, res.body);
      return products.flatMap((p) => p.variants.map((v) => toCatalogItem(p, v))).filter((i): i is LensItem => i.kind === "lens");
    });
  }

  async available(frame: FrameItem, store: Store): Promise<number> {
    if (!this.inventoryItemOf.has(frame.variantId)) await this.getItem(frame.variantId);
    const item = this.inventoryItemOf.get(frame.variantId);
    if (!item) return 0;
    const res = await this.http.get("inventory_levels.json", { inventory_item_ids: item, location_ids: store.locationRef });
    const { inventory_levels } = parseUpstream("shopify", "inventory levels", InventoryLevelsResponseSchema, res.body);
    return inventory_levels[0]?.available ?? 0;
  }

  async createCustomer(input: NewCustomer): Promise<Customer> {
    try {
      const res = await this.http.post("customers.json", {
        customer: { first_name: input.firstName, last_name: input.lastName, phone: input.phone, ...(input.email ? { email: input.email } : {}), accepts_marketing: false },
      });
      return toCustomer(parseUpstream("shopify", "customer", CustomerResponseSchema, res.body).customer);
    } catch (e) {
      if (e instanceof AmbiguousWriteError || e instanceof RetriesExhaustedError) throw new CustomerOutcomeUnknown(e.message);
      if (e instanceof HttpError && e.status === 422 && JSON.stringify(e.body).includes("has already been taken")) {
        throw new CustomerAlreadyExists(`Shopify already has a customer with phone ${input.phone}.`);
      }
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw new CustomerRejected(`Shopify refused the customer: ${JSON.stringify(e.body)}`);
      throw e;
    }
  }

  async listStores(): Promise<Store[]> {
    return (await this.allStores()).filter((s) => s.active);
  }

  async listFrames(store: Store): Promise<(FrameItem & { available: number })[]> {
    const frames = await this.frames.get(async () => {
      const res = await this.http.get("products.json", { product_type: "Frame", limit: 250 });
      const { products } = parseUpstream("shopify", "product list", ProductsResponseSchema, res.body);
      return products.flatMap((p) => p.variants.map((v) => ({ item: toCatalogItem(p, v), inventoryItemId: v.inventory_item_id })));
    });
    // One stock read for the whole store rather than one per frame.
    const res = await this.http.get("inventory_levels.json", { location_ids: store.locationRef });
    const { inventory_levels } = parseUpstream("shopify", "inventory levels", InventoryLevelsResponseSchema, res.body);
    const stock = new Map(inventory_levels.map((l) => [l.inventory_item_id, l.available]));
    const out: (FrameItem & { available: number })[] = [];
    for (const { item, inventoryItemId } of frames) {
      if (item.kind !== "frame" || !item.sellable) continue;
      this.inventoryItemOf.set(item.variantId, inventoryItemId);
      out.push({ ...item, available: (inventoryItemId === null ? undefined : stock.get(inventoryItemId)) ?? 0 });
    }
    return out;
  }

  private allStores(): Promise<Store[]> {
    return this.locations.get(async () => {
      const { locations } = parseUpstream("shopify", "location list", LocationsResponseSchema, (await this.http.get("locations.json")).body);
      return locations.map(toStore);
    });
  }

  async getStore(code: string): Promise<Store | null> {
    const stores = await this.allStores();
    return stores.find((s) => s.code === code) ?? null;
  }

  async createOrder(bill: Bill): Promise<PostedOrder> {
    try {
      const res = await this.http.post("orders.json", toShopifyOrder(bill));
      return toPostedOrder(parseUpstream("shopify", "order", OrderResponseSchema, res.body).order);
    } catch (e) {
      if (e instanceof AmbiguousWriteError) throw new OrderOutcomeUnknown(e.message);
      if (e instanceof RetriesExhaustedError) throw new OrderOutcomeUnknown(e.message); // only 429s are retried on writes: nothing was written, but stay cautious
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw new OrderRejected(`Shopify refused the order: ${JSON.stringify(e.body)}`);
      throw e;
    }
  }

  async findOrderByInvoiceNo(bill: Bill): Promise<PostedOrder | null> {
    // Shopify has no index on note attributes; scan the store's orders since a day before the bill was made.
    const since = new Date(Date.parse(bill.createdAt) - 24 * 3600_000).toISOString();
    const res = await this.http.get("orders.json", { location_id: bill.store.locationRef, status: "any", created_at_min: since, limit: 250 });
    const { orders } = parseUpstream("shopify", "order list", OrdersResponseSchema, res.body);
    const hit = orders.find((o) => noteAttr(o, "invoice_no") === bill.invoiceNo);
    return hit ? toPostedOrder(hit) : null;
  }

  async maxInvoiceSeq(store: Store, prefix: string): Promise<number> {
    // One-off when a store's series is first used: continue after whatever the old POS issued.
    // Production needs pagination here (or a figure from finance); the mock has fewer than 250 orders.
    const res = await this.http.get("orders.json", { location_id: store.locationRef, status: "any", limit: 250 });
    const { orders } = parseUpstream("shopify", "order list", OrdersResponseSchema, res.body);
    return Math.max(0, ...orders.map((o) => parseInvoiceSeq(prefix, noteAttr(o, "invoice_no") ?? "") ?? 0));
  }

  async maxCreditNoteSeq(store: Store, prefix: string): Promise<number> {
    const res = await this.http.get("orders.json", { location_id: store.locationRef, status: "any", limit: 250 });
    const { orders } = parseUpstream("shopify", "order list", OrdersResponseSchema, res.body);
    const seqs = orders.flatMap((o) => o.refunds.map((r) => parseInvoiceSeq(prefix, r.note_attributes.find((a) => a.name === "credit_note_no")?.value ?? "") ?? 0));
    return Math.max(0, ...seqs);
  }

  async calculateRefund(cn: CreditNote): Promise<{ lineRef: string; amountPaise: Paise; taxPaise: Paise }[]> {
    // calculate is a read; the mock throttles it like a write, and retrying a read is always safe.
    const res = await this.http.request({ method: "POST", path: `orders/${cn.source.orderRef}/refunds/calculate.json`, body: toRefundCalculate(cn), idempotent: true });
    const { refund } = parseUpstream("shopify", "refund calculation", RefundCalculateResponseSchema, res.body);
    return refund.refund_line_items.map((l) => ({
      lineRef: String(l.line_item_id),
      amountPaise: fromShopifyMoney(l.subtotal) + fromShopifyMoney(l.total_tax),
      taxPaise: fromShopifyMoney(l.total_tax),
    }));
  }

  async createRefund(cn: CreditNote): Promise<{ refundRef: string }> {
    try {
      const res = await this.http.post(`orders/${cn.source.orderRef}/refunds.json`, toShopifyRefund(cn));
      return { refundRef: String(parseUpstream("shopify", "refund", RefundResponseSchema, res.body).refund.id) };
    } catch (e) {
      if (e instanceof AmbiguousWriteError || e instanceof RetriesExhaustedError) throw new OrderOutcomeUnknown(e.message);
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw new OrderRejected(`Shopify refused the refund: ${JSON.stringify(e.body)}`);
      throw e;
    }
  }

  async findRefund(cn: CreditNote): Promise<{ refundRef: string } | null> {
    const res = await this.http.get(`orders/${cn.source.orderRef}.json`);
    const { order } = parseUpstream("shopify", "order", OrderWithRefundsSchema, res.body);
    const hit = order.refunds.find((r) => r.note_attributes.some((a) => a.name === "credit_note_no" && a.value === cn.creditNoteNo));
    return hit ? { refundRef: String(hit.id) } : null;
  }

  async ordersSince(store: Store, sinceDate: string): Promise<LedgerOrder[]> {
    // status=any so refunded and cancelled orders are included. Production needs pagination (page_info);
    // one store's 90 days is well past 250 orders.
    const res = await this.http.get("orders.json", { location_id: store.locationRef, status: "any", created_at_min: `${sinceDate}T00:00:00+05:30`, limit: 250 });
    return parseUpstream("shopify", "order list", OrdersResponseSchema, res.body).orders.map(toLedgerOrder);
  }
}
