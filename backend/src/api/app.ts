import express from "express";
import type { PosConfig } from "../config/load.js";
import type { Db } from "../adapters/sqlite/db.js";
import type { LookupCustomer } from "../application/lookupCustomer.js";
import type { Carts } from "../application/carts.js";
import type { Checkout } from "../application/checkout.js";
import type { Refunds } from "../application/refunds.js";
import type { DayEnd } from "../application/dayEnd.js";
import { errorHandler } from "./errors.js";
import { customerRoutes } from "./routes/customers.js";
import { cartRoutes, catalogRoutes } from "./routes/carts.js";
import { billRoutes, checkoutRoute } from "./routes/bills.js";
import { refundRoutes } from "./routes/refunds.js";
import { reportRoutes } from "./routes/reports.js";

export interface AppDeps {
  config: PosConfig;
  db: Db;
  lookupCustomer: LookupCustomer;
  carts: Carts;
  checkout: Checkout;
  refunds: Refunds;
  dayEnd: DayEnd;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      offers: deps.config.offers.length,
      tax_rates: deps.config.taxRates.length,
      db_schema_version: deps.db.pragma("user_version", { simple: true }),
    });
  });

  app.use("/customers", customerRoutes(deps.lookupCustomer));
  app.use("/carts", cartRoutes(deps.carts));
  app.use("/carts", checkoutRoute(deps.checkout));
  app.use(refundRoutes(deps.refunds));
  app.use("/bills", billRoutes(deps.checkout));
  app.use("/reports", reportRoutes(deps.dayEnd));
  app.use("/catalog", catalogRoutes(deps.carts));

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "No such route" });
  });
  app.use(errorHandler);

  return app;
}
