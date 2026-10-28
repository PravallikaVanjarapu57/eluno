import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { loadPosConfig } from "../../src/config/load.js";
import { openDb } from "../../src/adapters/sqlite/db.js";
import type { LookupCustomer } from "../../src/application/lookupCustomer.js";
import type { CreateCustomer } from "../../src/application/createCustomer.js";
import type { Carts } from "../../src/application/carts.js";
import type { Checkout } from "../../src/application/checkout.js";
import type { Refunds } from "../../src/application/refunds.js";
import type { AuthService } from "../../src/application/auth.js";
import type { AuditLog, Clock } from "../../src/ports/index.js";
import type { Reference } from "../../src/application/reference.js";
import type { DayEnd } from "../../src/application/dayEnd.js";

describe("GET /health", () => {
  const app = createApp({ config: loadPosConfig("config"), db: openDb(":memory:"), lookupCustomer: {} as LookupCustomer, createCustomer: {} as CreateCustomer, carts: {} as Carts, checkout: {} as Checkout, refunds: {} as Refunds, dayEnd: {} as DayEnd, reference: {} as Reference, auth: { authenticate: () => null } as unknown as AuthService, audit: {} as AuditLog, clock: {} as Clock, http: { secureCookies: false, maxAgeMs: 1000, trustProxy: 0 } });

  it("reports loaded config and schema version", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, offers: 8, tax_rates: 7, db_schema_version: 6 });
  });

  it("answers an unknown route with JSON and a 401 until signed in", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });
});
