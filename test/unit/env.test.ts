import { describe, expect, it } from "vitest";
import { describeUpstreams, envWarnings, loadEnv } from "../../src/config/env.js";

describe("loadEnv", () => {
  it("defaults to the starter-kit mock for all three upstreams", () => {
    const env = loadEnv({});
    expect(env).toMatchObject({
      SHOPIFY_BASE_URL: "http://localhost:8787",
      SHOPIFY_API_VERSION: "2026-10",
      SMT_BASE_URL: "http://localhost:8787",
      TERMINAL_BASE_URL: "http://localhost:8787",
    });
    expect(env.SHOPIFY_ACCESS_TOKEN).toBeUndefined();
  });

  it("store tool and terminal follow SHOPIFY_BASE_URL unless set on their own", () => {
    expect(loadEnv({ SHOPIFY_BASE_URL: "http://localhost:9000" })).toMatchObject({ SMT_BASE_URL: "http://localhost:9000", TERMINAL_BASE_URL: "http://localhost:9000" });
    expect(loadEnv({ SHOPIFY_BASE_URL: "https://eluno.myshopify.com", SMT_BASE_URL: "https://smt.eluno.in", TERMINAL_BASE_URL: "https://pos.razorpay.example" })).toMatchObject({
      SHOPIFY_BASE_URL: "https://eluno.myshopify.com",
      SMT_BASE_URL: "https://smt.eluno.in",
      TERMINAL_BASE_URL: "https://pos.razorpay.example",
    });
  });

  it("an empty token means not set", () => {
    expect(loadEnv({ SHOPIFY_ACCESS_TOKEN: "" }).SHOPIFY_ACCESS_TOKEN).toBeUndefined();
    expect(loadEnv({ SHOPIFY_ACCESS_TOKEN: "shpat_abc" }).SHOPIFY_ACCESS_TOKEN).toBe("shpat_abc");
  });

  it("rejects malformed settings", () => {
    expect(() => loadEnv({ SHOPIFY_BASE_URL: "not a url" })).toThrow();
    expect(() => loadEnv({ SHOPIFY_API_VERSION: "latest" })).toThrow(/YYYY-MM/);
  });
});

describe("startup messages", () => {
  it("warns when pointed at a real shop without a token", () => {
    expect(envWarnings(loadEnv({ SHOPIFY_BASE_URL: "https://eluno.myshopify.com" }))[0]).toMatch(/SHOPIFY_ACCESS_TOKEN is not set/);
    expect(envWarnings(loadEnv({ SHOPIFY_BASE_URL: "https://eluno.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_abc" }))).toEqual([]);
    expect(envWarnings(loadEnv({}))).toEqual([]); // the local mock needs none
  });

  it("says whether a token is set, never what it is", () => {
    const line = describeUpstreams(loadEnv({ SHOPIFY_ACCESS_TOKEN: "shpat_secret123" }));
    expect(line).toContain("token set");
    expect(line).not.toContain("shpat_secret123");
  });
});
