import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { compose, type Composed } from "../../src/compose.js";
import { createApp } from "../../src/api/app.js";
import { startMock } from "../support/mock.js";
import { TEST_PASSWORD, provisionAll, signIn, testEnv } from "../support/auth.js";

let mock: Awaited<ReturnType<typeof startMock>>;
let deps: Composed;
let app: Express;

beforeAll(async () => {
  mock = await startMock(8800);
  deps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, TILL_TODAY: "2026-10-23" }));
  app = createApp(deps);
  await provisionAll(deps);
});
afterAll(() => mock.stop());

const login = (username: string, password = TEST_PASSWORD) => request(app).post("/auth/login").send({ username, password });
const cookieOf = (res: request.Response) => (res.headers["set-cookie"] as unknown as string[] | undefined)?.[0] ?? "";

describe("login and logout", () => {
  it("signs in with the right password: HttpOnly, SameSite=Strict cookie; identity and role from the server", async () => {
    const res = await login("s105");
    expect(res.status).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^eluno_sid=[\w-]{40,}/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Max-Age=\d+/);
    expect(cookie).not.toMatch(/Secure/); // tests run over plain HTTP
    expect(res.body.user).toMatchObject({ username: "s105", staffId: "S105", role: "salesperson", storeCodes: ["HSR"] });
    expect(res.body.user.permissions).toEqual(expect.arrayContaining(["customer:create", "billing:use"]));
    expect(res.body.user.permissions).not.toContain("report:download");
    expect(typeof res.body.csrfToken).toBe("string");
    // nothing secret in the body: no hash, no password, no session token
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/scrypt\$|password|passwordHash/i);
    expect(text).not.toContain(cookie.split(";")[0]!.split("=")[1]!);
  });

  it("production settings: Secure cookie with the __Host- prefix, still HttpOnly and SameSite=Strict", async () => {
    const secureDeps = compose(testEnv({ SHOPIFY_BASE_URL: mock.baseUrl, COOKIE_SECURE: "1" }));
    await secureDeps.provision(TEST_PASSWORD);
    const res = await request(createApp(secureDeps)).post("/auth/login").send({ username: "s105", password: TEST_PASSWORD });
    const cookie = cookieOf(res);
    expect(cookie).toMatch(/^__Host-eluno_sid=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Domain=/); // required by __Host-
  });

  it("wrong password, unknown user and an optometrist (no account) all get the same 401, and no cookie", async () => {
    for (const [u, p] of [["s105", "wrong password"], ["nobody", TEST_PASSWORD], ["s107", TEST_PASSWORD]] as const) {
      const res = await login(u, p);
      expect(res.status, u).toBe(401);
      expect(res.body).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Wrong username or password." });
      expect(cookieOf(res), u).toBe("");
    }
    expect((await request(app).post("/auth/login").send({ username: "s105" })).status).toBe(400);
  });

  it("GET /auth/me returns the signed-in user, and 401 when signed out", async () => {
    const s = await signIn(app, "s108");
    const me = await s.get("/auth/me");
    expect(me.body.user).toMatchObject({ staffId: "S108", role: "store_manager" });
    expect(me.body.csrfToken).toBe(s.csrf);
    expect((await request(app).get("/auth/me")).status).toBe(401);
  });

  it("logout ends the session on the server: the old cookie stops working", async () => {
    const res = await login("s106");
    const cookie = cookieOf(res).split(";")[0]!;
    const csrf = res.body.csrfToken as string;
    expect((await request(app).get("/auth/me").set("Cookie", cookie)).status).toBe(200);

    expect((await request(app).post("/auth/logout").set("Cookie", cookie)).status).toBe(403); // a write needs the CSRF token
    const out = await request(app).post("/auth/logout").set("Cookie", cookie).set("X-CSRF-Token", csrf);
    expect(out.status).toBe(204);
    expect(cookieOf(out)).toMatch(/eluno_sid=;/); // cleared in the browser too
    const replay = await request(app).get("/customers?phone=9000000005").set("Cookie", cookie);
    expect(replay.status).toBe(401);
    expect((await request(app).post("/auth/logout")).status).toBe(204); // already signed out is fine
  });

  it("repeated wrong passwords lock the username with 429 and Retry-After", async () => {
    for (let i = 0; i < 5; i++) await login("s110", "bad password");
    const locked = await login("s110");
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe("TOO_MANY_LOGINS");
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("unauthenticated and invalid sessions", () => {
  const protectedRoutes: [string, string][] = [
    ["get", "/customers?phone=9000000005"],
    ["post", "/customers"],
    ["get", "/catalog/lenses?phone=9000000005"],
    ["get", "/catalog/frames?store=HSR"],
    ["post", "/carts"],
    ["get", "/carts/abc"],
    ["post", "/carts/abc/checkout"],
    ["get", "/bills?store=HSR"],
    ["get", "/bills/ELU%2FHSR%2FFY26%2F00003"],
    ["post", "/bills/ELU%2FHSR%2FFY26%2F00003/refund"],
    ["get", "/reports/day-end?store=HSR"],
    ["get", "/reports/day-end.csv?store=HSR"],
    ["get", "/stores"],
    ["get", "/stores/HSR/staff"],
    ["get", "/config/reason-codes"],
    ["put", "/config/lens-rules"],
  ];

  it.each(protectedRoutes)("%s %s -> 401 without a session", async (method, path) => {
    const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method]!(path);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("health stays public", async () => {
    expect((await request(app).get("/health")).status).toBe(200);
  });

  it("forged, malformed and foreign cookies are not sessions", async () => {
    for (const c of ["eluno_sid=abc", "eluno_sid=", "eluno_sid=" + "A".repeat(43), "eluno_sid=../../etc/passwd", "other=1", "garbage"]) {
      expect((await request(app).get("/auth/me").set("Cookie", c)).status, c).toBe(401);
    }
  });

  it("an expired session is refused, and an account disabled after sign-in loses access at once", async () => {
    const expired = await login("s106");
    const c1 = cookieOf(expired).split(";")[0]!;
    deps.db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect((await request(app).get("/auth/me").set("Cookie", c1)).status).toBe(401);

    const live = await login("s118");
    const c2 = cookieOf(live).split(";")[0]!;
    expect((await request(app).get("/auth/me").set("Cookie", c2)).status).toBe(200);
    deps.db.prepare("UPDATE users SET active = 0 WHERE username = 's118'").run();
    expect((await request(app).get("/auth/me").set("Cookie", c2)).status).toBe(401);
  });
});

describe("the client cannot forge who it is", () => {
  it("role, staff id and approver in headers, body or login payload change nothing", async () => {
    const forged = await request(app).post("/auth/login").send({ username: "s105", password: TEST_PASSWORD, role: "store_manager", staffId: "S108", storeCodes: ["BR"] });
    expect(forged.body.user).toMatchObject({ staffId: "S105", role: "salesperson", storeCodes: ["HSR"] });

    const s = await signIn(app, "s105");
    const cart = await s.post("/carts").set({ "X-Role": "store_manager", "X-Staff-Id": "S108", "X-User": "s108" }).send({ phone: "9000000005", storeCode: "HSR", staffId: "S108", role: "store_manager" });
    expect(cart.status).toBe(201);
    expect(cart.body.staffId).toBe("S105");
    expect((await s.get("/auth/me").set("X-Role", "store_manager")).body.user.role).toBe("salesperson");
    expect((await s.get("/reports/day-end?store=HSR").set("X-Role", "store_manager")).status).toBe(403);
  });
});

describe("CSRF protection for state-changing requests", () => {
  it("a write with no token, a wrong token, or from another site is refused; the same writes succeed legitimately", async () => {
    const res = await login("s105");
    const cookie = cookieOf(res).split(";")[0]!;
    const csrf = res.body.csrfToken as string;
    const body = { phone: "9000000005", storeCode: "HSR" };
    const post = () => request(app).post("/carts").set("Cookie", cookie).send(body);

    const none = await post();
    expect(none.status).toBe(403);
    expect(none.body.code).toBe("CSRF_INVALID");
    expect((await post().set("X-CSRF-Token", "x".repeat(csrf.length))).status).toBe(403);
    expect((await post().set("X-CSRF-Token", csrf).set("Host", "till.test").set("Origin", "https://evil.test")).body.code).toBe("CSRF_INVALID");
    expect((await post().set("X-CSRF-Token", csrf).set("Host", "till.test").set("Origin", "not a url")).status).toBe(403);

    expect((await post().set("X-CSRF-Token", csrf)).status).toBe(201); // no Origin header (non-browser)
    expect((await post().set("X-CSRF-Token", csrf).set("Host", "till.test").set("Origin", "https://till.test")).status).toBe(201); // same site
  });

  it("one session's token does not work for another session", async () => {
    const a = await login("s105");
    const b = await login("s106");
    const res = await request(app).post("/carts").set("Cookie", cookieOf(a).split(";")[0]!).set("X-CSRF-Token", b.body.csrfToken).send({ phone: "9000000005", storeCode: "HSR" });
    expect(res.status).toBe(403);
  });

  it("sign-in from another site is refused, and reads are not affected by the check", async () => {
    const cross = await request(app).post("/auth/login").set("Host", "till.test").set("Origin", "https://evil.test").send({ username: "s105", password: TEST_PASSWORD });
    expect(cross.status).toBe(403);
    expect(cookieOf(cross)).toBe("");
    const s = await signIn(app, "s105");
    expect((await s.get("/stores").set("Origin", "https://evil.test")).status).toBe(200); // GET only reads; cookie is SameSite=Strict anyway
  });
});
