import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, enc, request } from "./client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("api client", () => {
  it("encodes invoice numbers containing slashes", () => {
    expect(enc("ELU/HSR/FY26/00003")).toBe("ELU%2FHSR%2FFY26%2F00003");
  });

  it("retries a GET through 429 and 503, then succeeds", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(429, {})).mockResolvedValueOnce(json(503, {})).mockResolvedValueOnce(json(200, { ok: true }));
    const r = await request("GET", "/health", { retries: 3 });
    expect(r).toEqual({ status: 200, data: { ok: true } });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("never retries a POST, even on 503 or a network drop", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(503, { code: "UPSTREAM_UNAVAILABLE", message: "down" }));
    await expect(request("POST", "/carts/1/checkout", { body: {} })).rejects.toMatchObject({ status: 503, code: "UPSTREAM_UNAVAILABLE", outcomeUnknown: true });
    expect(f).toHaveBeenCalledTimes(1);
    f.mockRejectedValue(new TypeError("fetch failed"));
    await expect(request("POST", "/carts/1/checkout", { body: {} })).rejects.toMatchObject({ status: 0, code: "NETWORK", outcomeUnknown: true });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("passes accepted non-2xx statuses (202 in progress, 402 declined) through as data", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(402, { status: "CANCELLED" })).mockResolvedValueOnce(json(202, { status: "NUMBERED" }));
    expect((await request("POST", "/x", { accept: [202, 402] })).status).toBe(402);
    expect((await request("POST", "/x", { accept: [202, 402] })).status).toBe(202);
  });

  it("surfaces the staff-facing message of a domain error and does not retry 4xx", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(422, { code: "LENS_RX_MISMATCH", message: "Right eye is out of range.", details: { x: 1 } }));
    const err = await request("GET", "/x").catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "LENS_RX_MISMATCH", message: "Right eye is out of range.", outcomeUnknown: false });
    expect(f).toHaveBeenCalledTimes(1);
  });
});
