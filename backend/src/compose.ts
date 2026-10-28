// Composition root: the one place that picks concrete adapters for the ports.
import type { Env } from "./config/env.js";
import { loadPosConfig } from "./config/load.js";
import { openDb } from "./adapters/sqlite/db.js";
import { HttpClient } from "./adapters/http/client.js";
import { ShopifyGateway } from "./adapters/shopify/gateway.js";
import { SmtClient, SmtStaffDirectory } from "./adapters/smt/client.js";
import { SqliteCartRepository } from "./adapters/sqlite/cartRepo.js";
import { SqliteAuditLog } from "./adapters/sqlite/auditLog.js";
import { SqliteBillRepository } from "./adapters/sqlite/billRepo.js";
import { TerminalClient } from "./adapters/terminal/client.js";
import { Checkout } from "./application/checkout.js";
import { Refunds } from "./application/refunds.js";
import { DayEnd } from "./application/dayEnd.js";
import { SqliteCreditNoteRepository } from "./adapters/sqlite/creditNoteRepo.js";
import { systemClock } from "./adapters/clock.js";
import { Reference } from "./application/reference.js";
import { LookupCustomer } from "./application/lookupCustomer.js";
import { Carts } from "./application/carts.js";
import { TaxTable } from "./domain/tax.js";
import type { AppDeps } from "./api/app.js";

export function compose(env: Env): AppDeps {
  const log = (msg: string) => console.log(msg);
  // Shopify is the system of record; the token goes to Shopify and nowhere else.
  const shopify = new ShopifyGateway(
    new HttpClient({
      baseUrl: `${env.SHOPIFY_BASE_URL}/admin/api/${env.SHOPIFY_API_VERSION}`,
      name: "shopify",
      headers: env.SHOPIFY_ACCESS_TOKEN ? { "X-Shopify-Access-Token": env.SHOPIFY_ACCESS_TOKEN } : {},
      log,
    }),
  );
  const smtHttp = new HttpClient({ baseUrl: env.SMT_BASE_URL, name: "smt", log });
  const smt = new SmtClient(smtHttp);
  const clock = systemClock(env.TILL_TODAY);
  const db = openDb(env.DB_PATH);
  const lookupCustomer = new LookupCustomer(shopify, smt, clock);
  const config = loadPosConfig(env.CONFIG_DIR);
  const carts = new SqliteCartRepository(db);
  const audit = new SqliteAuditLog(db);
  const taxes = new TaxTable(config.taxRates);
  const bills = new SqliteBillRepository(db);
  const creditNotes = new SqliteCreditNoteRepository(db);
  const staff = new SmtStaffDirectory(smtHttp);
  const terminal = new TerminalClient(new HttpClient({ baseUrl: env.TERMINAL_BASE_URL, name: "terminal", log }));

  return {
    config,
    db,
    lookupCustomer,
    carts: new Carts({
      lookup: lookupCustomer,
      prescriptions: smt,
      catalog: shopify,
      stock: shopify,
      stores: shopify,
      staff,
      carts,
      audit,
      clock,
      offers: config.offers,
      taxes,
      discountReasons: config.reasonCodes.discount,
    }),
    checkout: new Checkout({ carts, bills, stores: shopify, stock: shopify, terminal, orders: shopify, audit, clock, offers: config.offers, taxes, log }),
    refunds: new Refunds({
      bills,
      creditNotes,
      stores: shopify,
      staff,
      terminal,
      orders: shopify,
      audit,
      clock,
      refundReasons: config.reasonCodes.refund,
    }),
    dayEnd: new DayEnd({ ledger: shopify, stores: shopify, bills, creditNotes, clock }),
    reference: new Reference({ stores: shopify, frames: shopify, staff, reasonCodes: config.reasonCodes }),
  };
}
