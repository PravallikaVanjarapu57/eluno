import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express } from "express";
import { compose } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { addUser, provisionAll, signIn, testEnv, type Session } from "../support/auth.js";

// Real adapters against the starter-kit mock: proves our zod schemas match the upstream shapes.
let mock: Awaited<ReturnType<typeof startMock>>;
let app: Express;
let http: Session;

beforeAll(async () => {
  mock = await startMock(8791);
  const deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  app = createApp(deps);
  await provisionAll(deps);
  http = await signIn(app, "s105");
});
afterAll(() => mock.stop());

describe("GET /customers?phone= against the mock", () => {
  it("Karthik: priority + progressive campaign, valid in-store Rx RX5007", async () => {
    const res = await http.get("/customers").query({ phone: "9000000005" });
    expect(res.status).toBe(200);
    expect(res.body.customer).toMatchObject({ id: "80001005", firstName: "Karthik", lifetimeSpendPaise: 1849900 });
    expect(res.body.flags).toEqual({ priority: true, family: false, campaigns: ["progressive_oct26"] });
    expect(res.body.prescription).toMatchObject({ status: "valid", rx: { rxId: "RX5007", od: { add: 2.5 } }, warnings: [] });
  });

  it("customer 80001003: external Rx with off-grid axis -> valid with warnings", async () => {
    const res = await http.get("/customers").query({ phone: "+919000000003" });
    expect(res.body.prescription.status).toBe("valid");
    expect(res.body.prescription.warnings.join(" ")).toMatch(/axis 87°.*axis 92°/);
  });

  it("customer 80001027: future-dated RX5044 skipped, RX5043 used", async () => {
    const res = await http.get("/customers").query({ phone: "9000000027" });
    expect(res.body.prescription).toMatchObject({ status: "valid", rx: { rxId: "RX5043" } });
  });

  it("customer 80001000: only an expired Rx", async () => {
    const res = await http.get("/customers").query({ phone: "9000000000" });
    expect(res.body.prescription).toMatchObject({ status: "expired", latest: { rxId: "RX5001" } });
  });

  it("customer 80001014: no Rx on file", async () => {
    const res = await http.get("/customers").query({ phone: "9000000014" });
    expect(res.body.prescription.status).toBe("none_on_file");
  });

  it("unknown phone -> 404 with an actionable message", async () => {
    const res = await http.get("/customers").query({ phone: "9000000099" });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
  });

  it("bad input -> 400", async () => {
    expect((await http.get("/customers").query({ phone: "12" })).body.code).toBe("INVALID_PHONE");
    expect((await http.get("/customers").query({ phone: "" })).body.code).toBe("BAD_REQUEST");
  });

  it("upstream down -> 502, not a crash", async () => {
    // Sign in through the live mock first (accounts come from its roster), then point Shopify at a dead port.
    const deps = compose(testEnv({ SHOPIFY_BASE_URL: "http://localhost:1", SMT_BASE_URL: mock.baseUrl }));
    await addUser(deps, { staffId: "S105", role: "salesperson", storeCodes: ["HSR"] });
    const res = await (await signIn(createApp(deps), "s105")).get("/customers").query({ phone: "9000000005" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("UPSTREAM_UNAVAILABLE");
  }, 60_000);
});
