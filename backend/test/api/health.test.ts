import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/api/app.js";
import { loadPosConfig } from "../../src/config/load.js";
import { openDb } from "../../src/adapters/sqlite/db.js";
import type { LookupCustomer } from "../../src/application/lookupCustomer.js";
import type { Carts } from "../../src/application/carts.js";
import type { Checkout } from "../../src/application/checkout.js";
import type { Refunds } from "../../src/application/refunds.js";
import type { Reference } from "../../src/application/reference.js";
import type { DayEnd } from "../../src/application/dayEnd.js";

describe("GET /health", () => {
  const app = createApp({ config: loadPosConfig("config"), db: openDb(":memory:"), lookupCustomer: {} as LookupCustomer, carts: {} as Carts, checkout: {} as Checkout, refunds: {} as Refunds, dayEnd: {} as DayEnd, reference: {} as Reference });

  it("reports loaded config and schema version", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, offers: 8, tax_rates: 7, db_schema_version: 5 });
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const res = await request(app).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("NOT_FOUND");
  });
});
