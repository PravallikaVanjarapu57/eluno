import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { compose } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { provisionAll, signIn, testEnv, type Session } from "../support/auth.js";

// The documented demo scenarios (docs/DEMO_GUIDE.md part 4), run against a mock started with scripted failures.
// Each one gets its own mock so the failure counters cannot leak between them.

const API = "admin/api/2026-10";
type Mock = Awaited<ReturnType<typeof startMock>>;

async function till(port: number, fail: string[]) {
  const mock = await startMock(port, { fail });
  const deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  const app: Express = createApp(deps);
  await provisionAll(deps);
  const hsr: Session = await signIn(app, "s105");
  return { mock, hsr, deps };
}
const shopifyOrdersFor = async (mock: Mock, invoiceNo: string) => {
  const { orders } = (await (await fetch(`${mock.baseUrl}/${API}/orders.json?location_id=70000002&status=any&limit=250`)).json()) as { orders: { note_attributes: { value: string }[] }[] };
  return orders.filter((o) => o.note_attributes.some((a) => a.value === invoiceNo));
};
const newSale = async (hsr: Session) => {
  const cartId = (await hsr.post("/carts").send({ phone: "9000000005", storeCode: "HSR" })).body.id as string;
  expect((await hsr.post(`/carts/${cartId}/pairs`).send({ frameVariantId: "91000003", lensVariantId: "91000083" })).status).toBe(201);
  return cartId;
};

describe("mock failure injection itself", () => {
  let mock: Mock;
  beforeAll(async () => { mock = await startMock(8821, { fail: ["503:terminal/charges:2"] }); });
  afterAll(() => mock.stop());

  it("answers the scripted failures in order, then behaves, and a charge is idempotent on order_ref", async () => {
    const charge = () => fetch(`${mock.baseUrl}/terminal/charges`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount_paise: 100, method: "upi", order_ref: "ELU/X/1" }) });
    expect([(await charge()).status, (await charge()).status]).toEqual([503, 503]);
    const first = await charge();
    const again = await charge();
    expect(first.status).toBe(201);
    expect(again.status).toBe(200); // same order_ref: the stored charge, not a second one
    expect((await again.json()).charge_id).toBe((await first.json()).charge_id);
  });
});

describe("HTTP 503 from the terminal", () => {
  it("a short outage is absorbed by the bounded automatic retry: one charge, one order, no staff action", async () => {
    const { mock, hsr } = await till(8822, ["503:terminal/charges:2"]);
    try {
      const res = await hsr.post(`/carts/${await newSale(hsr)}/checkout`).send({ paymentMethod: "upi" });
      expect(res.status).toBe(201);
      expect(res.body.status).toBe("POSTED");
      expect(await shopifyOrdersFor(mock, res.body.invoiceNo)).toHaveLength(1);
    } finally { mock.stop(); }
  });

  it("a longer outage leaves the bill NUMBERED with 'payment status unknown'; Resume then pays it once and posts one order", async () => {
    const { mock, hsr } = await till(8823, ["503:terminal/charges:5"]); // all five automatic attempts fail
    try {
      const cartId = await newSale(hsr);
      const first = await hsr.post(`/carts/${cartId}/checkout`).send({ paymentMethod: "upi" });
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ status: "NUMBERED", payment: null, lastError: expect.stringMatching(/Payment status unknown/) });
      expect(await shopifyOrdersFor(mock, first.body.invoiceNo)).toHaveLength(0); // nothing was posted

      const retried = await hsr.post(`/carts/${cartId}/checkout`).send({ paymentMethod: "upi" }); // the same cart: the same bill
      expect(retried.body.invoiceNo).toBe(first.body.invoiceNo);
      expect(retried.body.status).toBe("POSTED");
      expect(await shopifyOrdersFor(mock, first.body.invoiceNo)).toHaveLength(1);
    } finally { mock.stop(); }
  });

  it("the answer to a charge is lost after the terminal captured it: retrying the same order_ref finds that charge instead of taking money twice", async () => {
    const { mock, hsr } = await till(8824, ["drop:terminal/charges:1"]);
    try {
      const res = await hsr.post(`/carts/${await newSale(hsr)}/checkout`).send({ paymentMethod: "upi" });
      expect(res.body.status).toBe("POSTED");
      const chargeId = res.body.payment.chargeId as string;
      // Asking the terminal again with the same order_ref returns that very charge.
      const replay = await fetch(`${mock.baseUrl}/terminal/charges`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ amount_paise: res.body.payment.amountPaise, method: "upi", order_ref: res.body.invoiceNo }) });
      expect((await replay.json()).charge_id).toBe(chargeId);
    } finally { mock.stop(); }
  });
});

describe("HTTP 429 from Shopify when posting the order", () => {
  it("is retried after Retry-After and the bill still posts once", async () => {
    const { mock, hsr } = await till(8825, ["429:orders.json:2"]);
    try {
      const res = await hsr.post(`/carts/${await newSale(hsr)}/checkout`).send({ paymentMethod: "upi" });
      expect(res.body.status).toBe("POSTED");
      expect(await shopifyOrdersFor(mock, res.body.invoiceNo)).toHaveLength(1);
    } finally { mock.stop(); }
  }, 20_000);

  it("when throttling outlasts the retries the customer has paid and the bill waits as CHARGED_NOT_POSTED; Resume posts it once", async () => {
    const { mock, hsr } = await till(8826, ["429:orders.json:15"]); // 3 posting rounds x 5 attempts
    try {
      const cartId = await newSale(hsr);
      const first = await hsr.post(`/carts/${cartId}/checkout`).send({ paymentMethod: "upi" });
      expect(first.status).toBe(202);
      expect(first.body).toMatchObject({ status: "CHARGED_NOT_POSTED", payment: { chargeId: expect.stringMatching(/^chg_/) } });
      expect(await shopifyOrdersFor(mock, first.body.invoiceNo)).toHaveLength(0);

      const resumed = await hsr.post(`/bills/${encodeURIComponent(first.body.invoiceNo)}/resume`);
      expect(resumed.body.status).toBe("POSTED");
      expect(resumed.body.payment.chargeId).toBe(first.body.payment.chargeId); // not charged again
      expect(await shopifyOrdersFor(mock, first.body.invoiceNo)).toHaveLength(1);
    } finally { mock.stop(); }
  }, 60_000);
});

describe("order created but the answer lost", () => {
  it("the till looks the order up by invoice number and adopts it instead of creating a second", async () => {
    const { mock, hsr, deps } = await till(8827, ["drop:orders.json:1"]);
    try {
      const res = await hsr.post(`/carts/${await newSale(hsr)}/checkout`).send({ paymentMethod: "upi" });
      expect(res.body.status).toBe("POSTED");
      expect(await shopifyOrdersFor(mock, res.body.invoiceNo)).toHaveLength(1);
      expect(deps.audit.forRef(res.body.invoiceNo).map((e) => e.action)).toEqual(expect.arrayContaining(["bill.post_failed", "bill.posted"]));
      expect(deps.audit.forRef(res.body.invoiceNo).find((e) => e.action === "bill.posted")?.payload).toMatchObject({ adopted: true });
    } finally { mock.stop(); }
  }, 20_000);
});
