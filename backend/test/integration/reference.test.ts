import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compose } from "../../src/compose.js";
import { loadEnv } from "../../src/config/env.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";

let mock: Awaited<ReturnType<typeof startMock>>;
let app: Express;
let appWithUi: Express;

beforeAll(async () => {
  mock = await startMock(8799);
  const env = loadEnv({ SHOPIFY_BASE_URL: mock.baseUrl, DB_PATH: ":memory:", TILL_TODAY: "2026-10-23" });
  app = createApp(compose(env));
  const dir = mkdtempSync(path.join(tmpdir(), "ui-"));
  writeFileSync(path.join(dir, "index.html"), "<html>till-ui</html>");
  appWithUi = createApp(compose({ ...env, DB_PATH: ":memory:" }), { staticDir: dir });
});
afterAll(() => mock.stop());

describe("reference data for the till screens", () => {
  it("GET /stores lists active billing stores only (HQ has no invoice prefix)", async () => {
    const res = await request(app).get("/stores");
    expect(res.status).toBe(200);
    const codes = res.body.map((s: { code: string }) => s.code);
    expect(codes).toContain("HSR");
    expect(res.body.find((s: { code: string }) => s.code === "HSR")).toEqual({ code: "HSR", name: "Eluno HSR Layout", invoicePrefix: "ELU/HSR/FY26/" });
    expect(res.body.every((s: { invoicePrefix: string }) => s.invoicePrefix !== "")).toBe(true);
  });

  it("GET /stores/:code/staff returns that store's roster with manager rights", async () => {
    const res = await request(app).get("/stores/HSR/staff");
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.find((s: { staffId: string }) => s.staffId === "S108")).toMatchObject({ role: "store_manager", canOverrideDiscount: true });
    expect(res.body.find((s: { staffId: string }) => s.staffId === "S105")).toMatchObject({ canOverrideDiscount: false });
  });

  it("unknown store -> 404 STORE_NOT_FOUND", async () => {
    const res = await request(app).get("/stores/NOPE/staff");
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("STORE_NOT_FOUND");
    expect((await request(app).get("/catalog/frames?store=NOPE")).status).toBe(404);
  });

  it("GET /catalog/frames?store= lists sellable frames with stock at that store", async () => {
    const res = await request(app).get("/catalog/frames?store=HSR");
    expect(res.status).toBe(200);
    const fr3 = res.body.find((f: { sku: string }) => f.sku === "FR-0003");
    expect(fr3).toMatchObject({ variantId: "91000003", pricePaise: 1099800, hsn: "90031900", rxAble: true });
    expect(typeof fr3.available).toBe("number");
    expect(res.body.every((f: { sku: string }) => f.sku.startsWith("FR-"))).toBe(true);
    // the archived frame is not offered
    expect(res.body.length).toBe(39);
  });

  it("frames requires a store", async () => {
    expect((await request(app).get("/catalog/frames")).status).toBe(400);
  });

  it("GET /config/reason-codes returns discount and refund codes", async () => {
    const res = await request(app).get("/config/reason-codes");
    expect(res.body.refund.map((r: { code: string }) => r.code)).toContain("CHANGED_MIND");
    expect(res.body.discount.map((r: { code: string }) => r.code)).toContain("WALKOUT_SAVE");
  });
});

describe("recent bills and the /api prefix", () => {
  it("GET /bills?store= lists recent bills newest first, and the same route works under /api", async () => {
    const cart = (await request(app).post("/carts").send({ phone: "9000000005", storeCode: "HSR", staffId: "S105" })).body.id;
    await request(app).post(`/carts/${cart}/pairs`).send({ frameVariantId: "91000003" });
    const paid = await request(app).post(`/carts/${cart}/checkout`).send({ paymentMethod: "cash" });
    expect(paid.status).toBe(201);
    for (const prefix of ["", "/api"]) {
      const res = await request(app).get(`${prefix}/bills?store=HSR`);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ invoiceNo: paid.body.invoiceNo, status: "POSTED", paymentMethod: "cash", payablePaise: paid.body.totals.payablePaise });
    }
    expect((await request(app).get(`/carts/${cart}/bill`)).body.invoiceNo).toBe(paid.body.invoiceNo);
    const empty = (await request(app).post("/carts").send({ phone: "9000000005", storeCode: "HSR", staffId: "S105" })).body.id;
    const none = await request(app).get(`/carts/${empty}/bill`);
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("BILL_NOT_FOUND");
    expect((await request(app).get("/bills")).status).toBe(400);
    expect((await request(app).get("/api/health")).body.ok).toBe(true);
    expect((await request(app).get("/api/health")).headers["cache-control"]).toBe("no-store");
  });
});

describe("serving the built UI", () => {
  it("serves index.html at / and for SPA paths, but API 404s stay JSON", async () => {
    expect((await request(appWithUi).get("/")).text).toContain("till-ui");
    expect((await request(appWithUi).get("/refunds")).text).toContain("till-ui");
    const missing = await request(appWithUi).get("/api/nope");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("NOT_FOUND");
    expect((await request(appWithUi).get("/api/health")).body.ok).toBe(true);
  });

  it("without a build the API alone still answers", async () => {
    expect((await request(app).get("/")).status).toBe(404);
  });
});
