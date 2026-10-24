import type { CatalogItem } from "../../domain/catalog.js";
import type { Customer } from "../../domain/customer.js";
import type { Store } from "../../domain/store.js";
import { fromShopifyMoney } from "./money.js";
import type { ShopifyCustomer, ShopifyLocation, ShopifyProduct, ShopifyVariant } from "./schemas.js";

export function toCustomer(c: ShopifyCustomer): Customer {
  return {
    id: String(c.id),
    firstName: c.first_name ?? "",
    lastName: c.last_name ?? "",
    phone: c.phone ?? "",
    tags: c.tags.split(",").map((t) => t.trim()).filter(Boolean),
    lifetimeSpendPaise: fromShopifyMoney(c.total_spent),
    ordersCount: c.orders_count,
  };
}

export function toCatalogItem(product: ShopifyProduct, v: ShopifyVariant): CatalogItem {
  const base = {
    variantId: String(v.id),
    sku: v.sku,
    pricePaise: fromShopifyMoney(v.price),
    hsn: v.eluno.hsn,
    sellable: product.status === "active",
  };
  const m = v.eluno;
  if (m.line_type === "frame") {
    return { ...base, kind: "frame", title: `${product.title} ${v.title}`, category: m.category, rxAble: m.rx_able };
  }
  const l = m.rx_limits;
  return {
    ...base,
    kind: "lens",
    title: `${product.title} ${v.title.replace(/_/g, " ")}`,
    config: { type: m.lens_type, index: m.index, coating: m.coating },
    limits: { sphMin: l.sph_min, sphMax: l.sph_max, cylAbsMax: l.cyl_abs_max, addRequired: l.add_required, addMin: l.add_min, addMax: l.add_max },
    labTatDays: m.lab_tat_days,
  };
}

export function toStore(l: ShopifyLocation): Store {
  return {
    code: l.eluno.store_code,
    name: l.name,
    locationRef: String(l.id),
    invoicePrefix: l.eluno.invoice_prefix ?? "",
    stateCode: l.eluno.state_code,
    active: l.active && l.eluno.kind === "store" && l.eluno.invoice_prefix !== null,
  };
}
