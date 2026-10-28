import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose } from "../../src/compose.js";
import { loadEnv } from "../../src/config/env.js";
import { addUser, signIn } from "../support/auth.js";
import { createApp } from "../../src/api/app.js";

// Three fake upstreams on separate ports, recording what the till sends each of them.
const seen: { upstream: string; path: string; headers: IncomingHttpHeaders }[] = [];
function fake(upstream: string, body: (path: string) => unknown) {
  const server = createServer((req, res) => {
    seen.push({ upstream, path: req.url ?? "", headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body(req.url ?? "")));
  });
  return new Promise<{ url: string; close: () => void }>((resolve) =>
    server.listen(0, () => resolve({ url: `http://localhost:${(server.address() as AddressInfo).port}`, close: () => server.close() })),
  );
}

let shopify: Awaited<ReturnType<typeof fake>>;
let smt: Awaited<ReturnType<typeof fake>>;
let terminal: Awaited<ReturnType<typeof fake>>;
beforeAll(async () => {
  shopify = await fake("shopify", () => ({ customers: [] }));
  smt = await fake("smt", () => ({ prescriptions: [] }));
  terminal = await fake("terminal", () => ({}));
});
afterAll(() => [shopify, smt, terminal].forEach((s) => s.close()));

describe("upstream configuration", () => {
  it("calls each system at its own URL and sends the Shopify token to Shopify only", async () => {
    const env = loadEnv({
      SHOPIFY_BASE_URL: shopify.url,
      SHOPIFY_API_VERSION: "2025-07",
      SHOPIFY_ACCESS_TOKEN: "shpat_test_token",
      SMT_BASE_URL: smt.url,
      TERMINAL_BASE_URL: terminal.url,
      DB_PATH: ":memory:",
    });
    const deps = compose({ ...env, AUTH_SCRYPT_LOG2N: 10 });
    await addUser(deps, { staffId: "S105", role: "salesperson", storeCodes: ["HSR"] });
    const res = await (await signIn(createApp(deps), "s105")).get("/customers").query({ phone: "9000000005" });
    expect(res.body.code).toBe("CUSTOMER_NOT_FOUND"); // the fake Shopify has no customers

    const toShopify = seen.filter((s) => s.upstream === "shopify");
    const toSmt = seen.filter((s) => s.upstream === "smt");
    expect(toShopify[0]!.path).toMatch(/^\/admin\/api\/2025-07\/customers\/search\.json\?/);
    expect(toShopify.every((s) => s.headers["x-shopify-access-token"] === "shpat_test_token")).toBe(true);
    expect(toSmt[0]!.path).toMatch(/^\/smt\/prescriptions\?/);
    expect(toSmt.every((s) => s.headers["x-shopify-access-token"] === undefined)).toBe(true);
  });
});
