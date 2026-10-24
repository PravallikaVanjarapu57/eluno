import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { compose } from "../../src/compose.js";
import { loadEnv } from "../../src/config/env.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";

const API = "admin/api/2026-10";

describe("checkout against the mock", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let app: Express;
  beforeAll(async () => {
    mock = await startMock(8793);
    app = createApp(compose(loadEnv({ SHOPIFY_BASE_URL: mock.baseUrl, DB_PATH: ":memory:", TILL_TODAY: "2026-10-23" })));
  });
  afterAll(() => mock.stop());

  const shopify = async (path: string) => (await fetch(`${mock.baseUrl}/${API}/${path}`)).json();
  const stockHsr = async () => (await shopify("inventory_levels.json?inventory_item_ids=92000003&location_ids=70000002")).inventory_levels[0].available;

  it("Karthik's bill lands in Shopify exactly as finance needs it", async () => {
    const before = await stockHsr();
    const cartId = (await request(app).post("/carts").send({ phone: "9000000005", storeCode: "HSR", staffId: "S105", channel: "whatsapp_booked" })).body.id;
    await request(app).post(`/carts/${cartId}/pairs`).send({ frameVariantId: "91000003", lensVariantId: "91000083" });

    const res = await request(app).post(`/carts/${cartId}/checkout`).send({ paymentMethod: "upi" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ invoiceNo: "ELU/HSR/FY26/00003", status: "POSTED", totals: { payablePaise: 1869700, taxPaise: 199693 }, payment: { method: "upi", chargeId: expect.stringMatching(/^chg_/) } });

    const { order } = await shopify(`orders/${res.body.shopify.orderId}.json`);
    expect(order).toMatchObject({ financial_status: "paid", total_price: "18697.00", total_tax: "1996.93", total_discounts: "1800.00", subtotal_price: "20497.00", location_id: 70000002 });
    expect(order.note_attributes).toContainEqual({ name: "invoice_no", value: "ELU/HSR/FY26/00003" });
    expect(order.line_items[1].properties).toContainEqual({ name: "rx_id", value: "RX5007" });
    expect(order.transactions[0]).toMatchObject({ kind: "sale", amount: "18697.00", gateway: "razorpay_terminal" });
    expect(await stockHsr()).toBe(before - 1);

    // Retrying the same checkout is harmless.
    const again = await request(app).post(`/carts/${cartId}/checkout`).send({ paymentMethod: "upi" });
    expect(again.body.invoiceNo).toBe("ELU/HSR/FY26/00003");
    const all = (await shopify("orders.json?location_id=70000002&status=any&limit=250")).orders;
    expect(all.filter((o: { note_attributes: { name: string; value: string }[] }) => o.note_attributes.some((a) => a.value === "ELU/HSR/FY26/00003"))).toHaveLength(1);

    // Invoice numbers contain slashes; clients encode them.
    expect((await request(app).get(`/bills/${encodeURIComponent("ELU/HSR/FY26/00003")}`)).body.status).toBe("POSTED");
  });

  it("a cash bill at another store starts that store's series after its old invoices", async () => {
    const cartId = (await request(app).post("/carts").send({ phone: "9000000004", storeCode: "JN", staffId: "S117" })).body.id;
    expect((await request(app).post(`/carts/${cartId}/pairs`).send({ frameVariantId: "91000019" })).status).toBe(201);
    const res = await request(app).post(`/carts/${cartId}/checkout`).send({ paymentMethod: "cash" });
    expect(res.body).toMatchObject({ invoiceNo: "ELU/JN/FY26/00004", status: "POSTED", payment: { method: "cash", chargeId: null } });
  });
});

describe("checkout against the FLAKY mock (random 429s and terminal 503s)", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let app: Express;
  beforeAll(async () => {
    mock = await startMock(8794, { flaky: true });
    app = createApp(compose(loadEnv({ SHOPIFY_BASE_URL: mock.baseUrl, DB_PATH: ":memory:", TILL_TODAY: "2026-10-23" })));
  });
  afterAll(() => mock.stop());

  it("8 bills, 3 refunds: each posted once, numbers consecutive, the day reconciles", async () => {
    const invoices: string[] = [];
    for (let i = 0; i < 8; i++) {
      const cartId = (await request(app).post("/carts").send({ phone: "9000000005", storeCode: "HSR", staffId: "S105" })).body.id;
      expect((await request(app).post(`/carts/${cartId}/pairs`).send({ lensVariantId: "91000083" })).status).toBe(201);
      const res = await request(app).post(`/carts/${cartId}/checkout`).send({ paymentMethod: i % 2 ? "card" : "upi" });
      expect(res.body.status).toBe("POSTED");
      invoices.push(res.body.invoiceNo);
    }
    expect(invoices).toEqual(Array.from({ length: 8 }, (_, i) => `ELU/HSR/FY26/${String(i + 3).padStart(5, "0")}`));
    const orders = (await (await fetch(`${mock.baseUrl}/${API}/orders.json?location_id=70000002&status=any&limit=250`)).json()).orders as { note_attributes: { name: string; value: string }[] }[];
    for (const inv of invoices) expect(orders.filter((o) => o.note_attributes.some((a) => a.name === "invoice_no" && a.value === inv))).toHaveLength(1);

    const creditNotes: string[] = [];
    for (const inv of invoices.slice(0, 3)) {
      const res = await request(app).post(`/bills/${encodeURIComponent(inv)}/refund`).send({ staffId: "S108", reasonCode: "CHANGED_MIND" });
      expect(res.body.status).toBe("POSTED");
      creditNotes.push(res.body.creditNoteNo);
    }
    expect(creditNotes).toEqual(["ELU/HSR/FY26/CN/00003", "ELU/HSR/FY26/CN/00004", "ELU/HSR/FY26/CN/00005"]);

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const day = (await request(app).get("/reports/day-end").query({ store: "HSR", date: today })).body;
    expect(day.sales.bills).toBe(8);
    expect(day.refunds.count).toBe(3);
    expect(day.netAfterRefundsPaise).toBe(day.sales.netSalesPaise - day.refunds.amountPaise);
    expect(day.reconciliation).toEqual({ status: "matched", mismatches: [] });
  }, 120_000);
});

describe("full refund against the mock", () => {
  let mock: Awaited<ReturnType<typeof startMock>>;
  let app: Express;
  beforeAll(async () => {
    mock = await startMock(8795);
    app = createApp(compose(loadEnv({ SHOPIFY_BASE_URL: mock.baseUrl, DB_PATH: ":memory:", TILL_TODAY: "2026-10-23" })));
  });
  afterAll(() => mock.stop());
  const shopify = async (path: string) => (await fetch(`${mock.baseUrl}/${API}/${path}`)).json();
  const stockHsr = async () => (await shopify("inventory_levels.json?inventory_item_ids=92000003&location_ids=70000002")).inventory_levels[0].available;

  it("bill then refund: tax reversed per line, frame back at HSR, lens not restocked, refund against the sale", async () => {
    const before = await stockHsr();
    const cartId = (await request(app).post("/carts").send({ phone: "9000000005", storeCode: "HSR", staffId: "S105" })).body.id;
    await request(app).post(`/carts/${cartId}/pairs`).send({ frameVariantId: "91000003", lensVariantId: "91000083" });
    const bill = (await request(app).post(`/carts/${cartId}/checkout`).send({ paymentMethod: "card" })).body;
    expect(await stockHsr()).toBe(before - 1);

    const enc = encodeURIComponent(bill.invoiceNo);
    const res = await request(app).post(`/bills/${enc}/refund`).send({ staffId: "S108", reasonCode: "CHANGED_MIND" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ creditNoteNo: "ELU/HSR/FY26/CN/00003", invoiceNo: bill.invoiceNo, status: "POSTED", totals: { amountPaise: 1869700, cgstPaise: 99847, sgstPaise: 99846 } });

    const { order } = await shopify(`orders/${bill.shopify.orderId}.json`);
    expect(order.financial_status).toBe("refunded");
    const [refund] = order.refunds;
    expect(refund.refund_line_items.map((l: { restock_type: string; location_id: number | null; subtotal: string; total_tax: string }) => [l.restock_type, l.location_id, l.subtotal, l.total_tax])).toEqual([
      ["return", 70000002, "8937.91", "1608.82"],
      ["no_restock", null, "7762.16", "388.11"],
    ]);
    expect(refund.transactions[0]).toMatchObject({ kind: "refund", amount: "18697.00", parent_id: order.transactions[0].id });
    expect(refund.note_attributes).toContainEqual({ name: "credit_note_no", value: "ELU/HSR/FY26/CN/00003" });
    expect(await stockHsr()).toBe(before);

    // Second request: same credit note, still one refund in Shopify.
    const again = await request(app).post(`/bills/${enc}/refund`).send({ staffId: "S108", reasonCode: "CHANGED_MIND" });
    expect(again.body.creditNoteNo).toBe("ELU/HSR/FY26/CN/00003");
    expect((await shopify(`orders/${bill.shopify.orderId}.json`)).order.refunds).toHaveLength(1);
    expect((await request(app).get(`/bills/${enc}/refunds`)).body).toHaveLength(1);
  });
});
