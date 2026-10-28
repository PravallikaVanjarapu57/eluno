import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { compose, type Composed } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { provisionAll, signIn, testEnv, type Session } from "../support/auth.js";
import request from "supertest";

let mock: Awaited<ReturnType<typeof startMock>>;
let deps: Composed;
let app: Express;
let sales: Session; // S105, salesperson, HSR
let mgr: Session; // S108, store manager, HSR
let brSales: Session; // S109, salesperson, BR

beforeAll(async () => {
  mock = await startMock(8811);
  deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  app = createApp(deps);
  await provisionAll(deps);
  [sales, mgr, brSales] = await Promise.all([signIn(app, "s105"), signIn(app, "s108"), signIn(app, "s109")]);
});
afterAll(() => mock.stop());

let seq = 40;
const newPhone = () => `90002${String(++seq).padStart(5, "0")}`;
const eye = (sph: number, cyl = 0, axis: number | null = null, add: number | null = null) => ({ sph, cyl, axis, add });
const rxBody = (over: Record<string, unknown> = {}) => ({ testedOn: "2026-10-01", od: eye(-2), os: eye(-1.75), pd: { binocular: 62 }, ...over });

async function makeCustomer(s: Session = sales, name = "Dev") {
  const res = await s.post("/customers").send({ phone: newPhone(), firstName: name, lastName: "Tester" });
  expect(res.status).toBe(201);
  return res.body.customer as { id: string; phone: string };
}

describe("customer list, search and pagination", () => {
  it("returns a page with a prescription summary per row, never the whole database", async () => {
    const res = await sales.get("/customers").query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.nextCursor).toEqual(expect.any(String));
    const row = res.body.items[0];
    expect(row.customer).toMatchObject({ id: expect.any(String), phone: expect.stringMatching(/^\+91/) });
    expect(row.prescriptions).toEqual({ count: expect.any(Number), latest: expect.anything() });
  });

  it("pages without repeats or gaps until nextCursor is null", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const res = await sales.get("/customers").query({ limit: 7, ...(cursor ? { cursor } : {}) });
      seen.push(...res.body.items.map((x: { customer: { id: string } }) => x.customer.id));
      cursor = res.body.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(30); // the seed has 30 customers
  });

  it("searches by phone fragment, name and email", async () => {
    const c = await sales.post("/customers").send({ phone: newPhone(), firstName: "Zorander", lastName: "Quimby", email: "zq@example.com" });
    const byName = await sales.get("/customers").query({ q: "zorand" });
    expect(byName.body.items.map((x: { customer: { id: string } }) => x.customer.id)).toEqual([c.body.customer.id]);
    expect((await sales.get("/customers").query({ q: "ZQ@example" })).body.items).toHaveLength(1);
    expect((await sales.get("/customers").query({ q: c.body.customer.phone.slice(-8) })).body.items).toHaveLength(1);
    expect((await sales.get("/customers").query({ q: "nobody-by-this-name" })).body).toEqual({ items: [], nextCursor: null });
  });

  it("treats search text as text: operators typed in the box do not widen the search", async () => {
    const res = await sales.get("/customers").query({ q: 'phone:"+919000000005" zzz' });
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it("rejects an out-of-range page size", async () => {
    expect((await sales.get("/customers").query({ limit: 500 })).status).toBe(400);
  });
});

describe("customer details and editing", () => {
  it("opens a customer by id; unknown and malformed ids are 404", async () => {
    const c = await makeCustomer();
    const res = await sales.get(`/customers/${c.id}`);
    expect(res.status).toBe(200);
    expect(res.body.customer.phone).toBe(c.phone);
    expect((await sales.get("/customers/1")).status).toBe(404);
    expect((await sales.get("/customers/1")).body.code).toBe("CUSTOMER_NOT_FOUND");
    expect((await sales.get("/customers/..%2Fadmin")).status).toBe(404);
  });

  it("edits contact details in place: same id, same phone, no second customer, prescriptions kept", async () => {
    const c = await makeCustomer();
    const rx = await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody());
    expect(rx.status).toBe(201);
    const before = (await sales.get("/customers").query({ q: c.phone.slice(-8) })).body.items;
    const res = await sales.patch(`/customers/${c.id}`).send({ firstName: "Renamed", lastName: "Person", email: "renamed@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ id: c.id, firstName: "Renamed", lastName: "Person", email: "renamed@example.com", phone: c.phone });
    const after = (await sales.get("/customers").query({ q: c.phone.slice(-8) })).body.items;
    expect(after).toHaveLength(before.length);
    expect(after[0].prescriptions.count).toBe(1);
    expect((await sales.get(`/customers/${c.id}/prescriptions`)).body.prescriptions[0].rx.rxId).toBe(rx.body.rx.rxId);
    // audited under the signed-in staff, with field names only
    expect(deps.audit.forRef(`customer:${c.id}`)).toContainEqual(expect.objectContaining({ action: "customer.updated", staffId: "S105", payload: { fields: ["firstName", "lastName", "email"] } }));
  });

  it("refuses to change the phone, and says why", async () => {
    const c = await makeCustomer();
    const res = await sales.patch(`/customers/${c.id}`).send({ phone: "9111122223" });
    expect(res.status).toBe(422);
    expect(res.body.details.fields.phone).toMatch(/cannot be changed/);
    expect((await sales.patch(`/customers/${c.id}`).send({ phone: c.phone, firstName: "Same" })).status).toBe(200); // resending the same number is fine
  });

  it("validates fields and names them", async () => {
    const c = await makeCustomer();
    const res = await sales.patch(`/customers/${c.id}`).send({ firstName: "  ", email: "not-an-email" });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("CUSTOMER_INVALID");
    expect(Object.keys(res.body.details.fields).sort()).toEqual(["email", "firstName"]);
  });

  it("an email already used by another customer is a 409 on the email field", async () => {
    const a = await sales.post("/customers").send({ phone: newPhone(), firstName: "A", email: "taken-one@example.com" });
    const b = await makeCustomer();
    const res = await sales.patch(`/customers/${b.id}`).send({ email: "taken-one@example.com" });
    expect(res.status).toBe(409);
    expect(res.body.details.fields.email).toBeDefined();
    expect(a.status).toBe(201);
  });

  it("editing a customer that does not exist is 404", async () => {
    expect((await sales.patch("/customers/12345").send({ firstName: "X" })).status).toBe(404);
  });
});

describe("duplicate phones", () => {
  it("two simultaneous creates of one number: one 201, one 409, one customer", async () => {
    const phone = newPhone();
    const [a, b] = await Promise.all([sales.post("/customers").send({ phone, firstName: "Race" }), mgr.post("/customers").send({ phone, firstName: "Race" })]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect((await sales.get("/customers").query({ q: phone.slice(-8) })).body.items).toHaveLength(1);
  });
});

describe("prescriptions", () => {
  it("adds a prescription: validity defaults to a year, source external, shown newest first, older ones kept", async () => {
    const c = await makeCustomer();
    const first = await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody({ testedOn: "2026-05-01" }));
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ status: "valid", eligible: true, rx: { source: "external", optometristId: null, testedOn: "2026-05-01", validUntil: "2027-05-01", customerId: c.id } });
    const second = await mgr.post(`/customers/${c.id}/prescriptions`).send(rxBody({ testedOn: "2026-10-02", od: eye(-2.5, -1, 90) }));
    const list = (await sales.get(`/customers/${c.id}/prescriptions`)).body.prescriptions;
    expect(list.map((v: { rx: { rxId: string } }) => v.rx.rxId)).toEqual([second.body.rx.rxId, first.body.rx.rxId]);
    expect(list[1].rx.od.sph).toBe(-2); // the older one is untouched
    expect((await sales.get(`/customers/${c.id}/prescriptions/${first.body.rx.rxId}`)).body.rx.rxId).toBe(first.body.rx.rxId);
    expect(deps.audit.forRef(`customer:${c.id}`)).toContainEqual(expect.objectContaining({ action: "prescription.created", staffId: "S108" }));
  });

  it("an expired prescription can be recorded as history and is marked expired and ineligible", async () => {
    const c = await makeCustomer();
    const res = await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody({ testedOn: "2025-01-10" }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "expired", eligible: false, reason: expect.stringMatching(/Expired on 2026-01-10/) });
  });

  it("the same clientRef twice stores one prescription (a double tap or a retry)", async () => {
    const c = await makeCustomer();
    const body = { ...rxBody(), clientRef: "client-ref-0001" };
    const [a, b] = [await sales.post(`/customers/${c.id}/prescriptions`).send(body), await sales.post(`/customers/${c.id}/prescriptions`).send(body)];
    expect(a.body.rx.rxId).toBe(b.body.rx.rxId);
    expect((await sales.get(`/customers/${c.id}/prescriptions`)).body.prescriptions).toHaveLength(1);
  });

  it.each([
    ["off the 0.25 grid", { od: eye(-2.1) }, "od.sph"],
    ["sph out of range", { os: eye(-25) }, "os.sph"],
    ["cylinder without axis", { od: eye(-2, -1.5, null) }, "od.axis"],
    ["axis without cylinder", { od: eye(-2, 0, 90) }, "od.axis"],
    ["axis beyond 180", { od: eye(-2, -1, 200) }, "od.axis"],
    ["add off the grid", { od: eye(-2, 0, null, 1.1) }, "od.add"],
    ["future test date", { testedOn: "2026-12-01" }, "testedOn"],
    ["expiry before the test", { validUntil: "2026-09-01" }, "validUntil"],
    ["expiry beyond two years", { validUntil: "2030-01-01" }, "validUntil"],
    ["impossible date", { testedOn: "2026-02-30" }, "testedOn"],
    ["PD out of range", { pd: { binocular: 10 } }, "pd.binocular"],
  ])("rejects %s with the field named", async (_n, over, field) => {
    const c = await makeCustomer();
    const res = await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody(over));
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("RX_INVALID");
    expect(res.body.details.fields[field]).toEqual(expect.any(String));
    expect((await sales.get(`/customers/${c.id}/prescriptions`)).body.prescriptions).toHaveLength(0); // nothing half-saved
  });

  it("a missing SPH is required, not defaulted", async () => {
    const c = await makeCustomer();
    const res = await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody({ od: { cyl: 0 } }));
    expect(res.status).toBe(422);
    expect(res.body.details.fields["od.sph"]).toMatch(/required/);
  });

  it("unknown customer or prescription is 404", async () => {
    expect((await sales.post("/customers/12345/prescriptions").send(rxBody())).status).toBe(404);
    const c = await makeCustomer();
    const res = await sales.get(`/customers/${c.id}/prescriptions/RX9999999`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("RX_NOT_FOUND");
  });

  it("a seeded customer's history carries valid, expired and future-dated statuses", async () => {
    const all = (await sales.get("/customers").query({ limit: 50 })).body.items as { customer: { id: string }; prescriptions: { count: number } }[];
    const statuses = new Set<string>();
    for (const row of all.filter((x) => x.prescriptions.count > 0)) {
      for (const v of (await sales.get(`/customers/${row.customer.id}/prescriptions`)).body.prescriptions) statuses.add(v.status);
    }
    expect([...statuses].sort()).toEqual(["expired", "future_dated", "valid"]);
  });
});

describe("starting a sale from a customer profile", () => {
  async function customerWith(...tests: string[]) {
    const c = await makeCustomer();
    const ids: string[] = [];
    for (const [i, testedOn] of tests.entries()) ids.push((await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody({ testedOn, od: eye(-2 - i * 0.5) }))).body.rx.rxId);
    return { c, ids };
  }

  it("creates a cart for the customer by id, with nothing selected yet", async () => {
    const { c } = await customerWith();
    const res = await sales.post("/carts").send({ customerId: c.id, storeCode: "HSR" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ customer: { id: c.id, phone: c.phone }, selectedRxId: null, staffId: "S105" });
    expect((await sales.post("/carts").send({ customerId: "12345", storeCode: "HSR" })).status).toBe(404);
    expect((await sales.post("/carts").send({ customerId: c.id, phone: c.phone, storeCode: "HSR" })).status).toBe(400); // one or the other
  });

  it("with two prescriptions in force a lens is refused until one is chosen; the choice then sticks", async () => {
    const { c, ids } = await customerWith("2026-09-01", "2026-10-01");
    const cart = (await sales.post("/carts").send({ customerId: c.id, storeCode: "HSR" })).body;
    const lens = (await sales.get("/catalog/lenses").query({ phone: c.phone, rx_id: ids[0] })).body.options.find((o: { valid: boolean }) => o.valid);
    const refused = await sales.post(`/carts/${cart.id}/pairs`).send({ lensVariantId: lens.variantId });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("RX_SELECTION_REQUIRED");

    const picked = await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: ids[0] });
    expect(picked.body.selectedRxId).toBe(ids[0]);
    const added = await sales.post(`/carts/${cart.id}/pairs`).send({ lensVariantId: lens.variantId });
    expect(added.status).toBe(201);
    expect(added.body.pairs[0].lens.rxId).toBe(ids[0]); // the older one, as chosen, not the newest
    expect((await sales.get(`/carts/${cart.id}`)).body.selectedRxId).toBe(ids[0]); // survives a reload
    expect(deps.audit.forRef(`cart:${cart.id}`)).toContainEqual(expect.objectContaining({ action: "cart.prescription_selected", staffId: "S105" }));
  });

  it("an expired, future-dated or foreign prescription cannot be selected", async () => {
    const { c, ids } = await customerWith("2025-01-10", "2026-10-02");
    const other = await customerWith("2026-10-01");
    const cart = (await sales.post("/carts").send({ customerId: c.id, storeCode: "HSR" })).body;
    const expired = await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: ids[0] });
    expect(expired.status).toBe(422);
    expect(expired.body.code).toBe("RX_NOT_IN_FORCE");
    expect((await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: other.ids[0] })).status).toBe(404);
    expect((await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: "RX9999999" })).body.code).toBe("RX_NOT_FOUND");
    expect((await sales.get(`/carts/${cart.id}`)).body.selectedRxId).toBeNull();
    expect((await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: ids[1] })).status).toBe(200);
    expect((await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: null })).body.selectedRxId).toBeNull(); // can be cleared
  });

  it("one prescription in force needs no choice, exactly as before", async () => {
    const { c, ids } = await customerWith("2026-10-01");
    const cart = (await sales.post("/carts").send({ customerId: c.id, storeCode: "HSR" })).body;
    const lens = (await sales.get("/catalog/lenses").query({ phone: c.phone })).body.options.find((o: { valid: boolean }) => o.valid);
    const added = await sales.post(`/carts/${cart.id}/pairs`).send({ lensVariantId: lens.variantId });
    expect(added.status).toBe(201);
    expect(added.body.pairs[0].lens.rxId).toBe(ids[0]);
  });

  it("a customer with no prescription still bills frames; the lens path says what to do", async () => {
    const { c } = await customerWith();
    const cart = (await sales.post("/carts").send({ customerId: c.id, storeCode: "HSR" })).body;
    expect((await sales.post(`/carts/${cart.id}/pairs`).send({ frameVariantId: "91000004" })).status).toBe(201);
    const lens = (await sales.get("/catalog/lenses").query({ phone: c.phone })).status;
    expect(lens).toBe(422); // RX_NOT_IN_FORCE: no prescription to match lenses against
  });

  it("the whole flow ends in a posted bill: customer -> prescription -> select -> frame + lens -> quote -> checkout", async () => {
    const c = await makeCustomer(sales, "Flow");
    const rx = (await sales.post(`/customers/${c.id}/prescriptions`).send(rxBody())).body.rx.rxId;
    const cart = (await sales.post("/carts").send({ customerId: c.id, storeCode: "HSR" })).body;
    await sales.put(`/carts/${cart.id}/prescription`).send({ rxId: rx });
    const lens = (await sales.get("/catalog/lenses").query({ phone: c.phone, rx_id: rx })).body.options.find((o: { valid: boolean }) => o.valid);
    expect((await sales.post(`/carts/${cart.id}/pairs`).send({ frameVariantId: "91000001", lensVariantId: lens.variantId })).status).toBe(201);
    const quote = (await sales.get(`/carts/${cart.id}/quote`)).body;
    expect(quote.totals.payablePaise).toBeGreaterThan(0);
    const bill = await sales.post(`/carts/${cart.id}/checkout`).send({ paymentMethod: "upi" });
    expect([201, 202]).toContain(bill.status);
    expect(bill.body.customer.id).toBe(c.id);
    expect(bill.body.lines.find((l: { rxId?: string }) => l.rxId)?.rxId).toBe(rx);
    const bills = (await sales.get(`/customers/${c.id}/bills`)).body.bills;
    expect(bills).toEqual([expect.objectContaining({ invoiceNo: bill.body.invoiceNo, storeCode: "HSR" })]);
  });
});

describe("authorization", () => {
  it("every customer route needs a session", async () => {
    const anon = request(app);
    for (const [method, path] of [["get", "/customers"], ["get", "/customers/1"], ["patch", "/customers/1"], ["get", "/customers/1/prescriptions"], ["post", "/customers/1/prescriptions"], ["get", "/customers/1/bills"], ["put", "/carts/x/prescription"]] as const) {
      const res = await anon[method](path);
      expect([path, res.status]).toEqual([path, 401]);
    }
  });

  it("a signed-in write without the CSRF token is refused", async () => {
    const c = await makeCustomer();
    const agent = request.agent(app);
    await agent.post("/auth/login").send({ username: "s105", password: (await import("../support/auth.js")).TEST_PASSWORD });
    const res = await agent.patch(`/customers/${c.id}`).send({ firstName: "Nope" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CSRF_INVALID");
  });

  it("who edits or enters is taken from the session; a staffId in the body changes nothing", async () => {
    const c = await makeCustomer();
    await sales.post(`/customers/${c.id}/prescriptions`).send({ ...rxBody(), staffId: "S108", optometristId: "S103", source: "in_store" });
    const rx = (await sales.get(`/customers/${c.id}/prescriptions`)).body.prescriptions[0];
    expect(rx.rx).toMatchObject({ source: "external", optometristId: null });
    expect(deps.audit.forRef(`customer:${c.id}`).find((e) => e.action === "prescription.created")?.staffId).toBe("S105");
  });

  it("customers are shared across stores, but the bills list only shows the caller's stores", async () => {
    const c = await makeCustomer(sales);
    expect((await brSales.get(`/customers/${c.id}`)).status).toBe(200);
    expect((await brSales.get(`/customers/${c.id}/bills`)).body.bills).toEqual([]);
    expect((await brSales.post("/carts").send({ customerId: c.id, storeCode: "HSR" })).status).toBe(403); // not their store
  });

  it("nobody can touch lens rules, whatever they are allowed to do with customers and prescriptions", async () => {
    for (const s of [sales, mgr]) {
      const res = await s.put("/catalog/lens-rules").send({ any: "thing" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("LENS_RULES_LOCKED");
    }
  });

  it("day-end stays manager-only", async () => {
    expect((await sales.get("/reports/day-end").query({ store: "HSR", date: "2026-10-23" })).status).toBe(403);
    expect((await sales.get("/reports/day-end.csv").query({ store: "HSR", date: "2026-10-23" })).status).toBe(403);
    expect((await mgr.get("/reports/day-end.csv").query({ store: "HSR", date: "2026-10-23" })).status).toBe(200);
  });
});
