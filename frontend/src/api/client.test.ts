import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, download, enc, request, setCsrfToken, setUnauthorizedHandler } from "./client";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => {
  vi.restoreAllMocks();
  setCsrfToken(null);
  setUnauthorizedHandler(null);
});

const headersOf = (f: ReturnType<typeof vi.spyOn>, call = 0) => ((f.mock.calls[call]![1] as RequestInit).headers ?? {}) as Record<string, string>;

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
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(503, { code: "UPSTREAM_UNAVAILABLE", message: "down" }));
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
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(422, { code: "LENS_RX_MISMATCH", message: "Right eye is out of range.", details: { x: 1 } }));
    const err = await request("GET", "/x").catch((e: unknown) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: "LENS_RX_MISMATCH", message: "Right eye is out of range.", outcomeUnknown: false });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("sends the CSRF token on writes only, and always includes the cookie for this origin", async () => {
    setCsrfToken("tok123");
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(200, {}));
    await request("GET", "/stores");
    await request("POST", "/customers", { body: { phone: "1" } });
    await request("DELETE", "/carts/1/pairs/1");
    expect(headersOf(f, 0)["X-CSRF-Token"]).toBeUndefined();
    expect(headersOf(f, 1)["X-CSRF-Token"]).toBe("tok123");
    expect(headersOf(f, 2)["X-CSRF-Token"]).toBe("tok123");
    for (let i = 0; i < 3; i++) expect((f.mock.calls[i]![1] as RequestInit).credentials).toBe("same-origin");
  });

  it("never puts credentials in the URL or in browser storage", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(200, { user: {}, csrfToken: "t" }));
    await request("POST", "/auth/login", { body: { username: "s105", password: "secret-pass" } });
    expect(String(f.mock.calls[0]![0])).toBe("/api/auth/login");
    expect(String(f.mock.calls[0]![0])).not.toContain("secret-pass");
  });

  it("a 401 on a normal request tells the app the session ended; on /auth/* it does not", async () => {
    const ended = vi.fn();
    setUnauthorizedHandler(ended);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(401, { code: "UNAUTHENTICATED", message: "Please sign in." }));
    await expect(request("GET", "/stores", { retries: 0 })).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledTimes(1);
    await expect(request("POST", "/auth/login", { body: {} })).rejects.toMatchObject({ status: 401 });
    await expect(request("GET", "/auth/me")).rejects.toMatchObject({ status: 401 });
    expect(ended).toHaveBeenCalledTimes(1); // wrong password / signed-out check are not "session ended"
  });

  it("a 403 is shown to the user and does not sign them out", async () => {
    const ended = vi.fn();
    setUnauthorizedHandler(ended);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(403, { code: "FORBIDDEN", message: "Only store managers can download reports." }));
    await expect(request("GET", "/reports/day-end.csv?store=HSR")).rejects.toMatchObject({ status: 403, message: "Only store managers can download reports." });
    expect(ended).not.toHaveBeenCalled();
  });

  it("download returns the file and its server-chosen name; a refusal becomes the server's message", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("section,item\r\n", { status: 200, headers: { "Content-Disposition": 'attachment; filename="eluno-day-end-HSR-2026-10-23.csv"' } }));
    const out = await download("/reports/day-end.csv?store=HSR&date=2026-10-23");
    expect(out.filename).toBe("eluno-day-end-HSR-2026-10-23.csv");
    expect(await out.blob.text()).toBe("section,item\r\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(json(403, { code: "FORBIDDEN", message: "Only store managers can download reports." }));
    await expect(download("/reports/day-end.csv?store=HSR")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });
});
