import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PosConfig } from "../config/load.js";
import type { Db } from "../adapters/sqlite/db.js";
import type { LookupCustomer } from "../application/lookupCustomer.js";
import type { CreateCustomer } from "../application/createCustomer.js";
import type { Carts } from "../application/carts.js";
import type { Checkout } from "../application/checkout.js";
import type { Refunds } from "../application/refunds.js";
import type { DayEnd } from "../application/dayEnd.js";
import type { Reference } from "../application/reference.js";
import type { AuthService } from "../application/auth.js";
import type { AuditLog, Clock } from "../ports/index.js";
import { DomainError } from "../domain/errors.js";
import { loadSession, refuseCrossSite, requireAuth, requireCsrf, requirePermission } from "./middleware/auth.js";
import { authRoutes } from "./routes/auth.js";
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
  createCustomer: CreateCustomer;
  carts: Carts;
  checkout: Checkout;
  refunds: Refunds;
  dayEnd: DayEnd;
  reference: Reference;
  auth: AuthService;
  audit: AuditLog;
  clock: Clock;
  /** Session cookie settings and proxy trust; see config/env.ts. */
  http: { secureCookies: boolean; maxAgeMs: number; trustProxy: number };
}

export interface AppOptions {
  /** Built frontend (Vite `dist`). When it exists it is served at `/`, with the API under `/api`. */
  staticDir?: string;
}

export function createApp(deps: AppDeps, options: AppOptions = {}): express.Express {
  const app = express();
  if (deps.http.trustProxy > 0) app.set("trust proxy", deps.http.trustProxy);
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));

  const cookies = { secure: deps.http.secureCookies, maxAgeMs: deps.http.maxAgeMs };
  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  api.use(refuseCrossSite);
  api.use(loadSession(deps.auth, cookies));

  // Public: liveness and sign-in. Everything below requires a signed-in user, and every write also a CSRF token.
  api.get("/health", (_req, res) => {
    res.json({
      ok: true,
      offers: deps.config.offers.length,
      tax_rates: deps.config.taxRates.length,
      db_schema_version: deps.db.pragma("user_version", { simple: true }),
    });
  });
  api.use("/auth", authRoutes(deps.auth, cookies));

  api.use(requireAuth);
  api.use(requireCsrf);

  // Lens validation rules live in code and config and are read-only over HTTP. Who may administer them is an open product
  // question, so no role can: any write to the catalogue/config area, and any call to a rules path, is refused for everyone.
  api.use(["/catalog", "/config"], (req, _res, next) => {
    const rules = /^\/(?:lens-rules|lenses\/rules)(?:\/|$)/.test(req.path);
    if ((req.method !== "GET" && req.method !== "HEAD") || rules) {
      return next(new DomainError("LENS_RULES_LOCKED", "Lens validation rules cannot be created or changed from the till. This is not available to any role yet.", { method: req.method }));
    }
    next();
  });

  const billing = requirePermission("billing:use", "Your role cannot bill.");
  api.use("/customers", customerRoutes(deps.lookupCustomer, deps.createCustomer));
  api.use("/carts", billing, cartRoutes(deps.carts));
  api.use("/carts", billing, checkoutRoute(deps.checkout, deps.carts));
  api.use(refundRoutes(deps.refunds, deps.checkout));
  api.use("/bills", billing, billRoutes(deps.checkout));
  api.use("/reports", reportRoutes(deps.dayEnd, deps.audit, deps.clock));
  api.use("/catalog", catalogRoutes(deps.carts));
  api.use(referenceRoutes(deps.reference));

  const staticDir = options.staticDir && existsSync(path.join(options.staticDir, "index.html")) ? options.staticDir : null;
  app.use("/api", api);
  if (staticDir) {
    // The UI deployment: static files and the single-page app are public (they hold no data); the API lives only under /api.
    app.use(express.static(staticDir));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
      res.sendFile(path.resolve(staticDir, "index.html"));
    });
  } else {
    // API-only (tests, scripts): the same routes are also reachable at the root.
    app.use(api);
  }

  app.use((_req, res) => {
    res.status(404).json({ code: "NOT_FOUND", message: "No such route" });
  });
  app.use(errorHandler);

  return app;
}
