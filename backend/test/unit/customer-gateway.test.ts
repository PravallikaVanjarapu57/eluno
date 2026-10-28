import { describe, expect, it } from "vitest";
import { HttpClient } from "../../src/adapters/http/client.js";
import { ShopifyGateway } from "../../src/adapters/shopify/gateway.js";
import { CustomerAlreadyExists, CustomerOutcomeUnknown, CustomerRejected } from "../../src/ports/index.js";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function gateway(responses: (() => Response | Promise<Response>)[]) {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fetchFake = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const next = responses[Math.min(i++, responses.length - 1)]!;
    return next();
  }) as unknown as typeof fetch;
  const http = new HttpClient({ baseUrl: "http://shopify.test/admin/api/2026-10", name: "shopify", fetch: fetchFake, sleep: async () => {}, random: () => 0, maxAttempts: 3 });
  return { gw: new ShopifyGateway(http), calls };
}

const created = { customer: { id: 99000010, first_name: "Asha", last_name: "Menon", phone: "+919000012345", tags: "", total_spent: "0.00", orders_count: 0 } };
const input = { phone: "+919000012345", firstName: "Asha", lastName: "Menon" };

describe("ShopifyGateway.createCustomer", () => {
  it("POSTs customers.json in Shopify's shape and maps the response", async () => {
    const { gw, calls } = gateway([() => json(201, created)]);
    const c = await gw.createCustomer({ ...input, email: "asha@example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://shopify.test/admin/api/2026-10/customers.json");
    expect(calls[0]!.body).toEqual({ customer: { first_name: "Asha", last_name: "Menon", phone: "+919000012345", email: "asha@example.com", accepts_marketing: false } });
    expect(c).toEqual({ id: "99000010", firstName: "Asha", lastName: "Menon", phone: "+919000012345", tags: [], lifetimeSpendPaise: 0, ordersCount: 0 });
  });

  it("422 phone already taken -> CustomerAlreadyExists", async () => {
    const { gw } = gateway([() => json(422, { errors: { phone: ["has already been taken"] } })]);
    await expect(gw.createCustomer(input)).rejects.toBeInstanceOf(CustomerAlreadyExists);
  });

  it("other 4xx -> CustomerRejected (not retried)", async () => {
    const { gw, calls } = gateway([() => json(422, { errors: { phone: ["is invalid"] } })]);
    await expect(gw.createCustomer(input)).rejects.toBeInstanceOf(CustomerRejected);
    expect(calls).toHaveLength(1);
  });

  it("503 on this write is NOT retried blindly: outcome unknown", async () => {
    const { gw, calls } = gateway([() => json(503, {})]);
    await expect(gw.createCustomer(input)).rejects.toBeInstanceOf(CustomerOutcomeUnknown);
    expect(calls).toHaveLength(1);
  });

  it("a network drop is outcome unknown too", async () => {
    const { gw } = gateway([() => Promise.reject(new TypeError("fetch failed"))]);
    await expect(gw.createCustomer(input)).rejects.toBeInstanceOf(CustomerOutcomeUnknown);
  });

  it("429 means nothing was written, so it is retried after Retry-After", async () => {
    const { gw, calls } = gateway([() => json(429, {}, { "Retry-After": "1.0" }), () => json(201, created)]);
    expect((await gw.createCustomer(input)).id).toBe("99000010");
    expect(calls).toHaveLength(2);
  });

  it("429 on every attempt ends as outcome unknown rather than an unhandled error", async () => {
    const { gw } = gateway([() => json(429, {}, { "Retry-After": "0" })]);
    await expect(gw.createCustomer(input)).rejects.toBeInstanceOf(CustomerOutcomeUnknown);
  });

  it("a response in an unexpected shape is an upstream shape error, not a customer", async () => {
    const { gw } = gateway([() => json(201, { customer: { id: "x" } })]);
    await expect(gw.createCustomer(input)).rejects.toMatchObject({ name: "Error", message: expect.stringMatching(/unexpected customer/) });
  });
});
