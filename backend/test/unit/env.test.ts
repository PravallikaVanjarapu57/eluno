import { describe, expect, it } from "vitest";
import { describeUpstreams, envWarnings, loadEnv } from "../../src/config/env.js";

describe("loadEnv: authentication settings", () => {
  it("session cookies are Secure by default in production and not in development", () => {
    expect(loadEnv({ NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
    expect(loadEnv({}).COOKIE_SECURE).toBe(false);
    expect(loadEnv({ NODE_ENV: "production", COOKIE_SECURE: "0" }).COOKIE_SECURE).toBe(false);
    expect(loadEnv({ COOKIE_SECURE: "1" }).COOKIE_SECURE).toBe(true);
  });

  it("the demo password must be long enough, and an empty value means not set", () => {
    expect(() => loadEnv({ AUTH_DEMO_PASSWORD: "short" })).toThrow();
    expect(loadEnv({ AUTH_DEMO_PASSWORD: "" }).AUTH_DEMO_PASSWORD).toBeUndefined();
    expect(loadEnv({ AUTH_DEMO_PASSWORD: "a-long-enough-password" }).AUTH_DEMO_PASSWORD).toBe("a-long-enough-password");
  });

  it("describeUpstreams never prints the demo password", () => {
    expect(describeUpstreams(loadEnv({ AUTH_DEMO_PASSWORD: "a-long-enough-password" }))).not.toContain("a-long-enough-password");
  });
});

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
