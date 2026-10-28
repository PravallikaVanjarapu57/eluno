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
import { CreateCustomer } from "./application/createCustomer.js";
import { LookupCustomer } from "./application/lookupCustomer.js";
import { Customers } from "./application/customers.js";
import { Prescriptions } from "./application/prescriptions.js";
import { Carts } from "./application/carts.js";
import { TaxTable } from "./domain/tax.js";
import { AuthService } from "./application/auth.js";
import { provisionUsers, type ProvisionResult } from "./application/provisionUsers.js";
import { ScryptHasher } from "./adapters/crypto/scrypt.js";
import { SqliteSessionRepository, SqliteUserRepository } from "./adapters/sqlite/authRepo.js";
import type { AppDeps } from "./api/app.js";

export interface Composed extends AppDeps {
  /** Create/refresh one login per salesperson and store manager on the store-tool roster. Operator-run, never over HTTP. */
  provision(password: string): Promise<ProvisionResult>;
}

export function compose(env: Env): Composed {
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

  const users = new SqliteUserRepository(db);
  const hasher = new ScryptHasher(env.AUTH_SCRYPT_LOG2N);
  const auth = new AuthService({
    users,
    sessions: new SqliteSessionRepository(db),
    hasher,
    clock,
    audit,
    policy: { idleMs: env.AUTH_IDLE_MINUTES * 60_000, maxMs: env.AUTH_MAX_HOURS * 3_600_000 },
  });

  return {
    config,
    db,
    lookupCustomer,
    createCustomer: new CreateCustomer({ customers: shopify, lookup: lookupCustomer, audit, clock }),
    customers: new Customers({ customers: shopify, prescriptions: smt, bills, audit, clock }),
    prescriptions: new Prescriptions({ customers: shopify, source: smt, registry: smt, audit, clock }),
    carts: new Carts({
      lookup: lookupCustomer,
      customers: shopify,
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
    auth,
    audit,
    clock,
    http: { secureCookies: env.COOKIE_SECURE, maxAgeMs: env.AUTH_MAX_HOURS * 3_600_000, trustProxy: env.TRUST_PROXY },
    provision: (password) => provisionUsers({ roster: staff, stores: shopify, users, hasher, clock, password }),
  };
}
