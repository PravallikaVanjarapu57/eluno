import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { compose } from "../../src/compose.js";
import { loadEnv } from "../../src/config/env.js";
import { createApp } from "../../src/api/app.js";
import { istDate } from "../../src/domain/dayEnd.js";
import { startMock } from "../support/mock.js";

let mock: Awaited<ReturnType<typeof startMock>>;
let app: Express;
beforeAll(async () => {
  mock = await startMock(8796);
  app = createApp(compose(loadEnv({ SHOPIFY_BASE_URL: mock.baseUrl, DB_PATH: ":memory:", TILL_TODAY: "2026-10-23" })));
});
afterAll(() => mock.stop());

const dayEnd = async (store: string, date: string) => {
  const res = await request(app).get("/reports/day-end").query({ store, date });
  expect(res.status).toBe(200);
  return res.body;
};

describe("day-end from Shopify (seed orders from the old POS)", () => {
  it("Jayanagar 2026-10-06: 3 bills; cash matches the till session's cash sales", async () => {
    const r = await dayEnd("JN", "2026-10-06");
    expect(r.sales).toMatchObject({ bills: 3, grossPaise: 2099300, discountPaise: 0, taxPaise: 304505, netSalesPaise: 2099300, averageBillPaise: 699767 });
    expect(r.sales.taxablePaise + r.sales.taxPaise).toBe(r.sales.netSalesPaise);
    expect(r.byPaymentMethod).toEqual({
      cash: { salesPaise: 1449600, refundsPaise: 0, netPaise: 1449600, bills: 2 }, // = 899800 + 549800 in till_sessions_sample.json
      upi: { salesPaise: 649700, refundsPaise: 0, netPaise: 649700, bills: 1 },
    });
    expect(r.reconciliation.status).toBe("matched");
    expect(r.reconciliation.mismatches.map((m: { kind: string }) => m.kind)).toEqual(["NOT_FROM_THIS_TILL", "NOT_FROM_THIS_TILL", "NOT_FROM_THIS_TILL"]);
  });

  it("HSR 2026-10-12: no bills, but #1007's refund (billed 10-09) lands here", async () => {
    const r = await dayEnd("HSR", "2026-10-12");
    expect(r.sales.bills).toBe(0);
    expect(r.refunds).toEqual({ count: 1, amountPaise: 1849700, taxablePaise: 1619993, taxPaise: 229707 });
    expect(r.byPaymentMethod).toEqual({ upi: { salesPaise: 0, refundsPaise: 1849700, netPaise: -1849700, bills: 0 } });
    expect((await dayEnd("HSR", "2026-10-09")).refunds.count).toBe(0);
  });

  it("Indiranagar 2026-10-15: a zero-charge remake is a bill with no payment", async () => {
    const r = await dayEnd("IN", "2026-10-15");
    expect(r.sales).toMatchObject({ bills: 1, zeroValueBills: 1, netSalesPaise: 0, averageBillPaise: 0, discountPaise: 949900 });
    expect(r.byPaymentMethod).toEqual({});
  });

  it("unknown store and bad date are refused", async () => {
    expect((await request(app).get("/reports/day-end").query({ store: "XX", date: "2026-10-06" })).body.code).toBe("STORE_NOT_FOUND");
    expect((await request(app).get("/reports/day-end").query({ store: "HSR", date: "06-10-2026" })).status).toBe(400);
  });
});

describe("day-end after billing and refunding through this till", () => {
  it("reconciles: bill and refund both appear, the day nets to zero", async () => {
    const cartId = (await request(app).post("/carts").send({ phone: "9000000005", storeCode: "BR", staffId: "S109" })).body.id;
    expect((await request(app).post(`/carts/${cartId}/pairs`).send({ frameVariantId: "91000003", lensVariantId: "91000083" })).status).toBe(201);
    const bill = (await request(app).post(`/carts/${cartId}/checkout`).send({ paymentMethod: "upi" })).body;
    expect(bill.status).toBe("POSTED");

    const today = istDate(new Date().toISOString());
    let r = await dayEnd("BR", today);
    expect(r.sales).toMatchObject({ bills: 1, netSalesPaise: bill.totals.payablePaise, taxPaise: bill.totals.taxPaise });
    expect(r.discountsByOffer).toEqual({ FREE_BLUECUT_PGX: 100000, PRIORITY500: 50000, BUNDLE300: 30000 });
    expect(r.reconciliation).toEqual({ status: "matched", mismatches: [] });
    expect(r.invoices.first).toBe(bill.invoiceNo);

    await request(app).post(`/bills/${encodeURIComponent(bill.invoiceNo)}/refund`).send({ staffId: "S109", reasonCode: "CHANGED_MIND" });
    r = await dayEnd("BR", today);
    expect(r.refunds).toMatchObject({ count: 1, amountPaise: bill.totals.payablePaise, taxPaise: bill.totals.taxPaise });
    expect(r.netAfterRefundsPaise).toBe(0);
    expect(r.reconciliation.status).toBe("matched");
  });
});
