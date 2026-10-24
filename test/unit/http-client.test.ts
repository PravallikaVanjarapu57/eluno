import { describe, expect, it } from "vitest";
import { AmbiguousWriteError, HttpClient, HttpError, RetriesExhaustedError } from "../../src/adapters/http/client.js";

type Step = { status: number; body?: unknown; headers?: Record<string, string> } | "network-error";

function harness(steps: Step[], opts: { maxAttempts?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fakeFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps.shift();
    if (!step) throw new Error("no more scripted responses");
    if (step === "network-error") throw new TypeError("fetch failed");
    return new Response(step.body === undefined ? "" : JSON.stringify(step.body), { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  const client = new HttpClient({
    baseUrl: "http://mock/admin/api/2026-10",
    name: "shopify",
    fetch: fakeFetch,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 1,
    ...opts,
  });
  return { client, calls, sleeps };
}

describe("HttpClient", () => {
  it("builds URLs under the base path with query params", async () => {
    const { client, calls } = harness([{ status: 200, body: { customers: [] } }]);
    await client.get("customers/search.json", { query: "phone:+919000000005", skip: undefined });
    expect(calls[0]!.url).toBe("http://mock/admin/api/2026-10/customers/search.json?query=phone%3A%2B919000000005");
  });

  it("sends JSON bodies and returns parsed JSON", async () => {
    const { client, calls } = harness([{ status: 201, body: { order: { id: 1 } } }]);
    const res = await client.post("orders.json", { order: { taxes_included: true } });
    expect(res).toMatchObject({ status: 201, body: { order: { id: 1 } } });
    expect(calls[0]!.init.body).toBe('{"order":{"taxes_included":true}}');
  });

  it("sends configured headers (e.g. the Shopify token) on every request", async () => {
    const calls: Headers[] = [];
    const client = new HttpClient({
      baseUrl: "http://mock",
      name: "shopify",
      headers: { "X-Shopify-Access-Token": "shpat_abc" },
      fetch: (async (_u: string, init: RequestInit) => (calls.push(new Headers(init.headers)), new Response("{}", { status: 200 }))) as unknown as typeof fetch,
    });
    await client.get("a");
    await client.post("b", {});
    expect(calls.map((h) => h.get("X-Shopify-Access-Token"))).toEqual(["shpat_abc", "shpat_abc"]);
    expect(calls[1]!.get("Content-Type")).toBe("application/json");
  });

  it("retries a 429 on a non-idempotent write, honouring Retry-After", async () => {
    const { client, calls, sleeps } = harness([
      { status: 429, body: { errors: "slow down" }, headers: { "Retry-After": "1.0" } },
      { status: 201, body: { order: { id: 7 } } },
    ]);
    const res = await client.post("orders.json", {});
    expect(res.status).toBe(201);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it("does NOT retry a 503 on a non-idempotent write: outcome is unknown", async () => {
    const { client, calls } = harness([{ status: 503, body: { error: "down" } }]);
    await expect(client.post("orders.json", {})).rejects.toBeInstanceOf(AmbiguousWriteError);
    expect(calls).toHaveLength(1);
  });

  it("does NOT retry a network drop on a non-idempotent write", async () => {
    const { client } = harness(["network-error"]);
    await expect(client.post("orders.json", {})).rejects.toBeInstanceOf(AmbiguousWriteError);
  });

  it("retries a 503 on a write declared idempotent (terminal charge with the same order_ref)", async () => {
    const { client, calls, sleeps } = harness([
      { status: 503, body: { error: "terminal timeout, retry with the same order_ref" } },
      { status: 201, body: { charge_id: "chg_1", status: "captured" } },
    ]);
    const res = await client.post("terminal/charges", { order_ref: "ELU/HSR/FY26/00001" }, { idempotent: true });
    expect(res.body).toMatchObject({ charge_id: "chg_1" });
    expect(calls.map((c) => c.init.body)).toEqual([calls[0]!.init.body, calls[0]!.init.body]); // same body both times
    expect(sleeps).toHaveLength(1);
  });

  it("retries GETs on network errors with growing backoff", async () => {
    const { client, sleeps } = harness(["network-error", "network-error", { status: 200, body: { ok: true } }]);
    await client.get("health");
    expect(sleeps).toEqual([250, 500]);
  });

  it("fails fast on other 4xx with the upstream error body", async () => {
    const { client, calls } = harness([{ status: 422, body: { errors: { line_items: ["FR-0003: only 0 available"] } } }]);
    const err = await client.post("orders.json", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 422, body: { errors: { line_items: ["FR-0003: only 0 available"] } } });
    expect(calls).toHaveLength(1);
  });

  it("gives up after maxAttempts", async () => {
    const { client, calls } = harness(
      [{ status: 429, headers: { "Retry-After": "0.1" } }, { status: 429, headers: { "Retry-After": "0.1" } }, { status: 429, headers: { "Retry-After": "0.1" } }],
      { maxAttempts: 3 },
    );
    const err = await client.post("orders.json", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RetriesExhaustedError);
    expect(err.attempts).toBe(3);
    expect(calls).toHaveLength(3);
  });
});

describe("parseUpstream", () => {
  it("turns a shape mismatch into an upstream error, never a client validation error", async () => {
    const { z } = await import("zod");
    const { parseUpstream, UpstreamShapeError } = await import("../../src/adapters/http/client.js");
    expect(parseUpstream("shopify", "variant", z.object({ id: z.number() }), { id: 1 })).toEqual({ id: 1 });
    expect(() => parseUpstream("shopify", "variant", z.object({ id: z.number() }), { id: "1" })).toThrow(UpstreamShapeError);
  });
});
