import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { compose } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { provisionAll, signIn, testEnv, type Session } from "../support/auth.js";

let mock: Awaited<ReturnType<typeof startMock>>;
let app: Express;
let http: Session; // S105, a salesperson at HSR
let mgr: Session; // S108, the HSR store manager

beforeAll(async () => {
  mock = await startMock(8792);
  const deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  app = createApp(deps);
  await provisionAll(deps);
  http = await signIn(app, "s105");
  mgr = await signIn(app, "s108");
});
afterAll(() => mock.stop());

async function newCart(phone: string) {
  const res = await http.post("/carts").send({ phone, storeCode: "HSR", channel: "whatsapp_booked" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
}

describe("carts against the mock", () => {
  it("Karthik at HSR: frame + progressive 1.60 blue cut on RX5007 (the #1001 bill)", async () => {
    const id = await newCart("9000000005");
    const res = await http.post(`/carts/${id}/pairs`).send({ frameVariantId: 91000003, lensVariantId: "91000083" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      channel: "whatsapp_booked",
      customer: { id: "80001005", tags: ["campaign:progressive_oct26", "priority"] },
      pairs: [{ pairRef: "1", frame: { sku: "FR-0003", pricePaise: 1099800, hsn: "90031900" }, lens: { sku: "LN-0043", rxId: "RX5007", pricePaise: 949900, description: "progressive 1.60 blue cut" } }],
      mrpTotalPaise: 2049700,
    });
    // persisted
    expect((await http.get(`/carts/${id}`)).body.pairs).toHaveLength(1);
  });

  it("RX5026 (SPH -5.25) on single vision 1.56 -> 422 with the fix", async () => {
    const id = await newCart("9000000017");
    const res = await http.post(`/carts/${id}/pairs`).send({ lensVariantId: "91000045" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("LENS_RX_MISMATCH");
    expect(res.body.message).toMatch(/SPH -5.25 .*Choose index 1.60, 1.67, 1.74 for single vision/);
  });

  it("RX5016 (no ADD) on a progressive -> 422 ADD missing", async () => {
    const id = await newCart("9000000011");
    const res = await http.post(`/carts/${id}/pairs`).send({ lensVariantId: "91000081" });
    expect(res.body.details.issues.map((i: { code: string }) => i.code)).toEqual(["ADD_MISSING", "ADD_MISSING"]);
  });

  it("expired prescription blocks the lens, not the frame", async () => {
    const id = await newCart("9000000000");
    expect((await http.post(`/carts/${id}/pairs`).send({ lensVariantId: "91000041" })).body.code).toBe("RX_NOT_IN_FORCE");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000003" })).status).toBe(201);
  });

  it("stock is checked at the billing store, counting the cart", async () => {
    const id = await newCart("9000000005");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000009" })).body.code).toBe("OUT_OF_STOCK");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000001" })).status).toBe(201);
    const second = await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000001" });
    expect(second.body).toMatchObject({ code: "OUT_OF_STOCK", details: { available: 1, inCart: 1 } });
  });

  it("archived frame, non-Rx sunglasses with a lens, wrong item type", async () => {
    const id = await newCart("9000000005");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000040" })).body.code).toBe("ITEM_NOT_SELLABLE");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000004", lensVariantId: "91000049" })).body.code).toBe("FRAME_NOT_RX_ABLE");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000083" })).body.code).toBe("WRONG_ITEM_TYPE");
    expect((await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "1" })).body.code).toBe("ITEM_NOT_FOUND");
  });

  it("a cart is billed by the signed-in user at their own store; staffId in the body is not trusted", async () => {
    const forged = await http.post("/carts").send({ phone: "9000000005", storeCode: "HSR", staffId: "S106" });
    expect(forged.status).toBe(201);
    expect(forged.body.staffId).toBe("S105"); // the session, not the request
    const otherStore = await http.post("/carts").send({ phone: "9000000005", storeCode: "BR" });
    expect(otherStore.status).toBe(403);
    expect(otherStore.body.code).toBe("STORE_FORBIDDEN");
    const hq = await http.post("/carts").send({ phone: "9000000005", storeCode: "HQ" });
    expect(hq.body.code).toBe("STORE_FORBIDDEN");
  });

  it("remove a pair", async () => {
    const id = await newCart("9000000005");
    await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000003" });
    const res = await http.delete(`/carts/${id}/pairs/1`);
    expect(res.body.pairs).toEqual([]);
  });

  it("lens matrix for RX5040 (SPH -5.75, ADD 0.75): only 1.60+ progressives are valid", async () => {
    const res = await http.get("/catalog/lenses").query({ phone: "9000000025" });
    expect(res.status).toBe(200);
    expect(res.body.rxId).toBe("RX5040");
    const validProgressive = res.body.options.filter((o: { type: string; valid: boolean }) => o.type === "progressive" && o.valid);
    expect([...new Set(validProgressive.map((o: { index: number }) => o.index))]).toEqual([1.6, 1.67, 1.74]);
    const pgx156 = res.body.options.find((o: { type: string; index: number }) => o.type === "progressive" && o.index === 1.56);
    expect(pgx156.valid).toBe(false);
    expect(pgx156.reasons[0]).toMatch(/SPH -5.75/);
  });
});

describe("quote and manager discount against the mock", () => {
  it("Karthik's #1001 cart is quoted with the best combination", async () => {
    const id = await newCart("9000000005");
    await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000003", lensVariantId: "91000083" });
    const q = (await http.get(`/carts/${id}/quote`)).body;
    expect(q.totals).toEqual({ grossPaise: 2049700, discountPaise: 180000, taxablePaise: 1670007, cgstPaise: 99847, sgstPaise: 99846, taxPaise: 199693, payablePaise: 1869700 });
    expect(q.appliedOffers.map((a: { offerId: string }) => a.offerId)).toEqual(["FREE_BLUECUT_PGX", "PRIORITY500", "BUNDLE300"]);
    expect(q.lines).toEqual([
      expect.objectContaining({ lineId: "1:frame", sku: "FR-0003", grossPaise: 1099800, discountPaise: 45127, netPaise: 1054673, rateBps: 1800, cgstPaise: 80441 }),
      expect.objectContaining({ lineId: "1:lens", sku: "LN-0043", grossPaise: 949900, discountPaise: 134873, netPaise: 815027, rateBps: 500, cgstPaise: 19406 }),
    ]);
    expect(q.offerEvaluations).toHaveLength(8);
  });

  it("only the signed-in store manager can apply a manager discount, and they are the approver", async () => {
    const id = await newCart("9000000004");
    await http.post(`/carts/${id}/pairs`).send({ frameVariantId: "91000003" });
    const sales = await http.put(`/carts/${id}/manager-discount`).send({ reasonCode: "WALKOUT_SAVE", bps: 1000 });
    expect(sales.status).toBe(403);
    expect(sales.body.code).toBe("FORBIDDEN");
    expect(sales.body.message).toMatch(/store manager/);
    // naming a manager does not make a salesperson one
    expect((await http.put(`/carts/${id}/manager-discount`).send({ approverId: "S108", reasonCode: "WALKOUT_SAVE", bps: 1000 })).status).toBe(403);
    // a manager cannot name someone else as the approver either
    expect((await mgr.put(`/carts/${id}/manager-discount`).send({ approverId: "S104", reasonCode: "WALKOUT_SAVE", bps: 1000 })).status).toBe(403);

    const ok = await mgr.put(`/carts/${id}/manager-discount`).send({ reasonCode: "WALKOUT_SAVE", bps: 1000 });
    expect(ok.body.manualDiscount).toEqual({ approverId: "S108", reasonCode: "WALKOUT_SAVE", bps: 1000 });
    const q = (await http.get(`/carts/${id}/quote`)).body;
    // 10% of ₹10,998 = ₹1,099.80; ties with FESTIVE10 on the amount, FESTIVE10 has the lower priority number.
    expect(q.totals.discountPaise).toBe(109980);

    const cleared = await http.delete(`/carts/${id}/manager-discount`);
    expect(cleared.body.manualDiscount).toBeNull();
  });
});
