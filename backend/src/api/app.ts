import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PosConfig } from "../config/load.js";
import type { Db } from "../adapters/sqlite/db.js";
import type { LookupCustomer } from "../application/lookupCustomer.js";
import type { Carts } from "../application/carts.js";
import type { Checkout } from "../application/checkout.js";
import type { Refunds } from "../application/refunds.js";
import type { DayEnd } from "../application/dayEnd.js";
import type { Reference } from "../application/reference.js";
import { errorHandler } from "./errors.js";
import { customerRoutes } from "./routes/customers.js";
import { cartRoutes, catalogRoutes } from "./routes/carts.js";
import { billRoutes, checkoutRoute } from "./routes/bills.js";
import { refundRoutes } from "./routes/refunds.js";
import { reportRoutes } from "./routes/reports.js";
import { referenceRoutes } from "./routes/reference.js";

export interface AppDeps {
  config: PosConfig;
  db: Db;
  lookupCustomer: LookupCustomer;
  carts: Carts;
  checkout: Checkout;
  refunds: Refunds;
  dayEnd: DayEnd;
  reference: Reference;
}

export interface AppOptions {
  /** Built frontend (Vite `dist`). When it exists it is served at `/`, with the API under `/api`. */
  staticDir?: string;
}

export function createApp(deps: AppDeps, options: AppOptions = {}): express.Express {
  const app = express();
  app.use(express.json());

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  api.get("/health", (_req, res) => {
    res.json({
      ok: true,
      offers: deps.config.offers.length,
      tax_rates: deps.config.taxRates.length,
      db_schema_version: deps.db.pragma("user_version", { simple: true }),
    });
  });

  api.use("/customers", customerRoutes(deps.lookupCustomer));
  api.use("/carts", cartRoutes(deps.carts));
  api.use("/carts", checkoutRoute(deps.checkout));
  api.use(refundRoutes(deps.refunds));
  api.use("/bills", billRoutes(deps.checkout));
  api.use("/reports", reportRoutes(deps.dayEnd));
  api.use("/catalog", catalogRoutes(deps.carts));
  api.use(referenceRoutes(deps.reference));

  // The same routes are reachable at the root (existing clients, tests, Postman) and under /api (the browser UI).
  app.use("/api", api);
  app.use(api);

  const staticDir = options.staticDir && existsSync(path.join(options.staticDir, "index.html")) ? options.staticDir : null;
  if (staticDir) {
    app.use(express.static(staticDir));
    // Single-page app: any other GET (e.g. a reload on /refunds) gets index.html.
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
      res.sendFile(path.resolve(staticDir, "index.html"));
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "No such route" });
  });
  app.use(errorHandler);

  return app;
}
