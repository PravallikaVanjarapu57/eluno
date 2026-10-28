import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compose } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { provisionAll, signIn, testEnv, type Session } from "../support/auth.js";

let mock: Awaited<ReturnType<typeof startMock>>;
let app: Express;
let appWithUi: Express;
let http: Session; // S105, salesperson at HSR
let uiDir: string;

beforeAll(async () => {
  mock = await startMock(8799);
  const deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  app = createApp(deps);
  await provisionAll(deps);
  http = await signIn(app, "s105");
  uiDir = mkdtempSync(path.join(tmpdir(), "ui-"));
  writeFileSync(path.join(uiDir, "index.html"), "<html>till-ui</html>");
  appWithUi = createApp(compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl })), { staticDir: uiDir });
});
afterAll(() => mock.stop());

describe("reference data for the till screens (scoped to the signed-in user's store)", () => {
  it("GET /stores lists only the stores the user is assigned to", async () => {
    const res = await http.get("/stores");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ code: "HSR", name: "Eluno HSR Layout", invoicePrefix: "ELU/HSR/FY26/" }]);
  });

  it("GET /stores/:code/staff returns that store's roster with manager rights", async () => {
    const res = await http.get("/stores/HSR/staff");
    expect(res.status).toBe(200);
    expect(res.body.find((s: { staffId: string }) => s.staffId === "S108")).toMatchObject({ role: "store_manager", canOverrideDiscount: true });
    expect(res.body.find((s: { staffId: string }) => s.staffId === "S105")).toMatchObject({ canOverrideDiscount: false });
  });

  it("another store (or an unknown one) is refused, not revealed", async () => {
    for (const path of ["/stores/BR/staff", "/stores/NOPE/staff", "/catalog/frames?store=BR", "/catalog/frames?store=NOPE", "/bills?store=BR"]) {
      const res = await http.get(path);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("STORE_FORBIDDEN");
    }
  });

  it("GET /catalog/frames?store= lists sellable frames with stock at that store", async () => {
    const res = await http.get("/catalog/frames?store=HSR");
    expect(res.status).toBe(200);
    const fr3 = res.body.find((f: { sku: string }) => f.sku === "FR-0003");
    expect(fr3).toMatchObject({ variantId: "91000003", pricePaise: 1099800, hsn: "90031900", rxAble: true });
    expect(typeof fr3.available).toBe("number");
    expect(res.body.length).toBe(39); // the archived frame is not offered
    expect((await http.get("/catalog/frames")).status).toBe(400);
  });

  it("GET /config/reason-codes returns discount and refund codes", async () => {
    const res = await http.get("/config/reason-codes");
    expect(res.body.refund.map((r: { code: string }) => r.code)).toContain("CHANGED_MIND");
    expect(res.body.discount.map((r: { code: string }) => r.code)).toContain("WALKOUT_SAVE");
  });
});

describe("recent bills and the /api prefix", () => {
  it("GET /bills?store= lists recent bills newest first; the cart's bill is found by cart id", async () => {
    const cart = (await http.post("/carts").send({ phone: "9000000005", storeCode: "HSR" })).body.id;
    await http.post(`/carts/${cart}/pairs`).send({ frameVariantId: "91000003" });
    const paid = await http.post(`/carts/${cart}/checkout`).send({ paymentMethod: "cash" });
    expect(paid.status).toBe(201);
    for (const prefix of ["", "/api"]) {
      const res = await http.get(`${prefix}/bills?store=HSR`);
      expect(res.status).toBe(200);
      expect(res.body[0]).toMatchObject({ invoiceNo: paid.body.invoiceNo, status: "POSTED", paymentMethod: "cash", payablePaise: paid.body.totals.payablePaise });
    }
    expect((await http.get(`/carts/${cart}/bill`)).body.invoiceNo).toBe(paid.body.invoiceNo);
    const empty = (await http.post("/carts").send({ phone: "9000000005", storeCode: "HSR" })).body.id;
    const none = await http.get(`/carts/${empty}/bill`);
    expect(none.status).toBe(404);
    expect(none.body.code).toBe("BILL_NOT_FOUND");
    expect((await http.get("/bills")).status).toBe(400);
  });

  it("health is public and uncached", async () => {
    const res = await request(app).get("/api/health");
    expect(res.body.ok).toBe(true);
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("serving the built UI", () => {
  it("serves index.html at / and for SPA paths without a session; the API stays under /api and protected", async () => {
    expect((await request(appWithUi).get("/")).text).toContain("till-ui");
    expect((await request(appWithUi).get("/refunds")).text).toContain("till-ui");
    expect((await request(appWithUi).get("/api/health")).body.ok).toBe(true);
    const missing = await request(appWithUi).get("/api/nope");
    expect(missing.status).toBe(401); // unknown API paths do not reveal anything to the signed-out
    expect(missing.body.code).toBe("UNAUTHENTICATED");
    // not reachable at the root when the UI is served
    expect((await request(appWithUi).get("/customers?phone=9000000005")).text).toContain("till-ui");
  });

  it("without a build, API routes are also at the root and still require sign-in", async () => {
    expect((await request(app).get("/customers?phone=9000000005")).status).toBe(401);
    expect((await request(app).get("/health")).status).toBe(200);
  });
});
