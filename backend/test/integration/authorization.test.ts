import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { compose, type Composed } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { addUser, provisionAll, signIn, testEnv, type Session } from "../support/auth.js";
import { parseCsv } from "../support/csv.js";

let mock: Awaited<ReturnType<typeof startMock>>;
let deps: Composed;
let app: Express;
let sales: Session; // S105, salesperson, HSR
let mgr: Session; // S108, store manager, HSR
let brSales: Session; // S109, salesperson, BR
let brMgr: Session; // S112, store manager, BR
let jnMgr: Session; // S120, store manager, JN

beforeAll(async () => {
  mock = await startMock(8801);
  deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  app = createApp(deps);
  await provisionAll(deps);
  [sales, mgr, brSales, brMgr, jnMgr] = await Promise.all([signIn(app, "s105"), signIn(app, "s108"), signIn(app, "s109"), signIn(app, "s112"), signIn(app, "s120")]);
});
afterAll(() => mock.stop());

let phoneSeq = 10;
const newPhone = () => `90001${String(++phoneSeq).padStart(5, "0")}`;

describe("customer creation (salespeople can)", () => {
  it("a salesperson creates a customer, who is immediately billable", async () => {
    const phone = newPhone();
    const res = await sales.post("/customers").send({ phone, firstName: "Asha", lastName: "Menon", email: "asha@example.com" });
    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({ firstName: "Asha", lastName: "Menon", phone: `+91${phone}`, ordersCount: 0 });
    expect(res.body.flags).toEqual({ priority: false, family: false, campaigns: [] });
    expect(res.body.prescription.status).toBe("none_on_file");

    expect((await sales.get("/customers").query({ phone })).body.customer.id).toBe(res.body.customer.id); // lookup finds them
    const cart = await sales.post("/carts").send({ phone, storeCode: "HSR" });
    expect(cart.status).toBe(201);
    expect(cart.body.customer.name).toBe("Asha Menon");
    const pair = await sales.post(`/carts/${cart.body.id}/pairs`).send({ frameVariantId: "91000004" }); // a frame needs no prescription
    expect(pair.status).toBe(201);
    // recorded against the signed-in staff, not anything the client sent
    expect(deps.audit.forRef(`customer:${res.body.customer.id}`)).toEqual([expect.objectContaining({ action: "customer.created", staffId: "S105" })]);
  });

  it("a store manager can create customers too", async () => {
    expect((await mgr.post("/customers").send({ phone: newPhone(), firstName: "Ravi" })).status).toBe(201);
  });

  it("the phone is normalised, so a differently written duplicate is caught", async () => {
    const phone = newPhone();
    expect((await sales.post("/customers").send({ phone: `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`, firstName: "Meena" })).status).toBe(201);
    const dup = await mgr.post("/customers").send({ phone: `0${phone}`, firstName: "Meena again" });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: "CUSTOMER_EXISTS", details: { phone: `+91${phone}` } });
    expect(dup.body.message).toMatch(/Meena/);
  });

  it("an existing seed customer is refused without creating anything", async () => {
    const res = await sales.post("/customers").send({ phone: "9000000005", firstName: "Someone" });
    expect(res.status).toBe(409);
    expect(res.body.details.customerId).toBe("80001005");
    expect((await sales.get("/customers").query({ phone: "9000000005" })).body.customer.firstName).toBe("Karthik");
  });

  it("two tills creating the same phone at once: one customer, the other told it exists", async () => {
    const phone = newPhone();
    const results = await Promise.all([sales.post("/customers").send({ phone, firstName: "Race" }), mgr.post("/customers").send({ phone, firstName: "Race" })]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("CUSTOMER_EXISTS");
    const found = await fetch(`${mock.baseUrl}/admin/api/2026-10/customers/search.json?query=${encodeURIComponent(`phone:+91${phone}`)}`).then((r) => r.json());
    expect(found.customers).toHaveLength(1);
  });

  it("validates input: phone format, required name, email", async () => {
    expect((await sales.post("/customers").send({ phone: "12345", firstName: "A" })).body.code).toBe("INVALID_PHONE");
    expect((await sales.post("/customers").send({ phone: newPhone(), firstName: "" })).status).toBe(400);
    expect((await sales.post("/customers").send({ phone: newPhone() })).status).toBe(400);
    expect((await sales.post("/customers").send({ firstName: "A" })).status).toBe(400);
    expect((await sales.post("/customers").send({ phone: newPhone(), firstName: "A", email: "not-an-email" })).status).toBe(400);
    expect((await sales.post("/customers").send({ phone: newPhone(), firstName: "A".repeat(61) })).status).toBe(400);
  });

  it("an upstream failure on the write is a clear 502, and nothing is half-created", async () => {
    // A Shopify that answers searches but fails every write with 503.
    const seen: string[] = [];
    const shopify = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      if (req.method === "POST") {
        res.statusCode = 503;
        return void res.end("{}");
      }
      res.end(JSON.stringify({ customers: [] }));
    });
    await new Promise<void>((r) => shopify.listen(0, r));
    try {
      const broken = compose(testEnv({ SHOPIFY_BASE_URL: `http://localhost:${(shopify.address() as AddressInfo).port}`, SMT_BASE_URL: mock.baseUrl }));
      await addUser(broken, { staffId: "S105", role: "salesperson", storeCodes: ["HSR"] });
      const s = await signIn(createApp(broken), "s105");
      const res = await s.post("/customers").send({ phone: newPhone(), firstName: "Unlucky" });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(res.body.message).toMatch(/Look the phone number up/);
      expect(seen.filter((x) => x.startsWith("POST"))).toHaveLength(1); // not blindly retried
    } finally {
      shopify.close();
    }
  });

  it("needs a session and a CSRF token", async () => {
    expect((await sales.post("/customers").set("X-CSRF-Token", "wrong").send({ phone: newPhone(), firstName: "A" })).status).toBe(403);
  });
});

describe("lens validation rules cannot be changed by anyone", () => {
  const attempts: [string, string][] = [
    ["put", "/config/lens-rules"],
    ["post", "/config/lens-rules"],
    ["patch", "/config/lens-rules/single_vision"],
    ["delete", "/config/lens-rules/single_vision"],
    ["get", "/config/lens-rules"],
    ["post", "/catalog/lenses"],
    ["put", "/catalog/lenses/91000045"],
    ["post", "/catalog/lens-rules"],
    ["post", "/catalog/lenses/rules"],
    ["post", "/config/reason-codes"],
  ];

  it.each(attempts)("%s %s is refused for a salesperson and for a store manager", async (method, path) => {
    for (const who of [sales, mgr]) {
      const agent = (who as unknown as Record<string, (p: string) => import("supertest").Test>)[method === "patch" ? "put" : method]!;
      const res = await agent.call(who, path).send({ sphMin: -99, sphMax: 99, cylAbsMax: 99 });
      expect(res.status, `${who.user.role} ${method} ${path}`).toBe(403);
      expect(res.body.code).toBe("LENS_RULES_LOCKED");
    }
  });

  it("the lens matrix is unchanged afterwards: still server-side and still validating", async () => {
    const res = await sales.get("/catalog/lenses").query({ phone: "9000000017" });
    const sv156 = res.body.options.find((o: { sku: string }) => o.sku === "LN-0005");
    expect(sv156).toMatchObject({ valid: false });
    expect(sv156.reasons.join(" ")).toMatch(/-4.00 to \+4.00/);
    const cart = await sales.post("/carts").send({ phone: "9000000017", storeCode: "HSR" });
    const refused = await sales.post(`/carts/${cart.body.id}/pairs`).send({ lensVariantId: "91000045" });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe("LENS_RX_MISMATCH");
  });
});

describe("reports: manager-only, store-scoped, enforced on the server", () => {
  const url = (store: string, date: string, csv = false) => `/reports/day-end${csv ? ".csv" : ""}?store=${store}&date=${date}`;

  it("a salesperson gets 403 for the on-screen report and for the download", async () => {
    for (const csv of [false, true]) {
      const res = await sales.get(url("HSR", "2026-10-12", csv));
      expect(res.status, `csv=${csv}`).toBe(403);
      expect(res.body.code).toBe("FORBIDDEN");
      expect(res.text).not.toMatch(/net_sales|salesPaise/);
    }
  });

  it("a store manager downloads their own store's report as CSV", async () => {
    const res = await jnMgr.get(url("JN", "2026-10-06", true));
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers["content-disposition"]).toBe('attachment; filename="eluno-day-end-JN-2026-10-06.csv"');
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(deps.audit.forRef("day-end:JN:2026-10-06")).toEqual([expect.objectContaining({ action: "report.downloaded", staffId: "S120" })]);
  });

  it("the export matches the API report: totals and the payment-method breakdown", async () => {
    const json = (await jnMgr.get(url("JN", "2026-10-06"))).body;
    const rows = parseCsv((await jnMgr.get(url("JN", "2026-10-06", true))).text);
    const val = (section: string, item: string, col = 3) => rows.find((r) => r[0] === section && r[1] === item)?.[col];
    expect(json.sales.bills).toBeGreaterThan(0);
    expect(Number(val("sales", "bills", 2))).toBe(json.sales.bills);
    expect(Number(val("sales", "gross_mrp"))).toBe(json.sales.grossPaise);
    expect(Number(val("sales", "discounts"))).toBe(json.sales.discountPaise);
    expect(Number(val("sales", "taxable_value"))).toBe(json.sales.taxablePaise);
    expect(Number(val("sales", "cgst"))).toBe(json.sales.cgstPaise);
    expect(Number(val("sales", "sgst"))).toBe(json.sales.sgstPaise);
    expect(Number(val("sales", "gst_total"))).toBe(json.sales.taxPaise);
    expect(Number(val("sales", "net_sales"))).toBe(json.sales.netSalesPaise);
    expect(Number(val("refunds", "refunds"))).toBe(json.refunds.amountPaise);
    expect(Number(val("net", "net_after_refunds"))).toBe(json.netAfterRefundsPaise);
    for (const [method, v] of Object.entries(json.byPaymentMethod) as [string, { salesPaise: number; refundsPaise: number; netPaise: number; bills: number }][]) {
      expect(Number(val("payment_method", `${method} sales`))).toBe(v.salesPaise);
      expect(Number(val("payment_method", `${method} refunds`))).toBe(v.refundsPaise);
      expect(Number(val("payment_method", `${method} net`))).toBe(v.netPaise);
      expect(Number(val("payment_method", `${method} sales`, 2))).toBe(v.bills);
    }
    expect(Object.keys(json.byPaymentMethod).length).toBeGreaterThan(0);
    expect(val("report", "reconciliation", 5)).toBe(json.reconciliation.status);
    expect(val("invoices", "first", 5)).toBe(json.invoices.first ?? ""); // null on a day with only old-POS orders
  });

  it("a manager cannot read or download another store's report", async () => {
    for (const csv of [false, true]) {
      const res = await brMgr.get(url("HSR", "2026-10-12", csv));
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("STORE_FORBIDDEN");
    }
  });

  it("bad input is a clean 400, not a broken file", async () => {
    expect((await mgr.get("/reports/day-end.csv?store=HSR&date=12-10-2026")).status).toBe(400);
    expect((await mgr.get("/reports/day-end.csv")).status).toBe(400);
  });
});

describe("store scoping and attribution of bills and refunds", () => {
  let invoice: string;
  let cartId: string;
  const enc = (s: string) => encodeURIComponent(s);

  beforeAll(async () => {
    cartId = (await sales.post("/carts").send({ phone: "9000000005", storeCode: "HSR" })).body.id;
    await sales.post(`/carts/${cartId}/pairs`).send({ frameVariantId: "91000004" });
    const bill = await sales.post(`/carts/${cartId}/checkout`).send({ paymentMethod: "cash" });
    expect(bill.status).toBe(201);
    invoice = bill.body.invoiceNo;
  });

  it("another store's people cannot see, resume, cancel, refund or checkout this store's data", async () => {
    for (const who of [brSales, brMgr]) {
      expect((await who.get(`/carts/${cartId}`)).status).toBe(403);
      expect((await who.get(`/carts/${cartId}/quote`)).status).toBe(403);
      expect((await who.post(`/carts/${cartId}/checkout`).send({ paymentMethod: "cash" })).status).toBe(403);
      expect((await who.get(`/bills/${enc(invoice)}`)).status).toBe(403);
      expect((await who.post(`/bills/${enc(invoice)}/resume`)).status).toBe(403);
      expect((await who.post(`/bills/${enc(invoice)}/cancel`).send({ reason: "no reason at all" })).status).toBe(403);
      expect((await who.post(`/bills/${enc(invoice)}/refund`).send({ reasonCode: "CHANGED_MIND" })).status).toBe(403);
      expect((await who.get(`/bills/${enc(invoice)}/refunds`)).status).toBe(403);
      expect((await who.get("/bills?store=HSR")).status).toBe(403);
    }
    expect((await mgr.get(`/bills/${enc(invoice)}`)).status).toBe(200); // the store's own manager can
  });

  it("a refund is attributed to the signed-in user; a staffId in the body is ignored", async () => {
    const res = await sales.post(`/bills/${enc(invoice)}/refund`).send({ staffId: "S108", reasonCode: "CHANGED_MIND" });
    expect(res.status).toBe(201);
    expect(res.body.staffId).toBe("S105");
    expect(deps.audit.forRef(res.body.creditNoteNo).every((e) => e.staffId === "S105")).toBe(true);
    // and other stores still cannot read the credit note
    expect((await brMgr.get(`/credit-notes/${enc(res.body.creditNoteNo)}`)).status).toBe(403);
    expect((await mgr.get(`/credit-notes/${enc(res.body.creditNoteNo)}`)).status).toBe(200);
  });

  it("the bill's staff is the person who started the sale", async () => {
    const audit = deps.audit.forRef(invoice);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((e) => e.staffId === "S105")).toBe(true);
  });
});
