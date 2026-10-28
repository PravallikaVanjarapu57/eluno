import { beforeEach, describe, expect, it } from "vitest";
import { ScryptHasher } from "../../src/adapters/crypto/scrypt.js";
import { openDb } from "../../src/adapters/sqlite/db.js";
import { SqliteSessionRepository, SqliteUserRepository } from "../../src/adapters/sqlite/authRepo.js";
import { AuthService } from "../../src/application/auth.js";
import { provisionUsers } from "../../src/application/provisionUsers.js";
import type { Staff, Store } from "../../src/domain/store.js";
import type { AuditEvent } from "../../src/ports/index.js";

const hasher = new ScryptHasher(10); // cheap for tests
const PASSWORD = "unit-test password 12345";

let now = Date.parse("2026-10-28T09:00:00Z");
const clock = { now: () => new Date(now), today: () => "2026-10-28" };
const minutes = (n: number) => n * 60_000;

function setup(policy = {}) {
  now = Date.parse("2026-10-28T09:00:00Z");
  const db = openDb(":memory:");
  const users = new SqliteUserRepository(db);
  const sessions = new SqliteSessionRepository(db);
  const audit: AuditEvent[] = [];
  const auth = new AuthService({ users, sessions, hasher, clock, audit: { record: (e) => void audit.push(e), forRef: () => [] }, policy });
  return { db, users, sessions, auth, audit };
}

async function addUser(s: ReturnType<typeof setup>, over: Partial<Parameters<typeof s.users.upsert>[0]> = {}) {
  s.users.upsert({ userId: "usr_S105", username: "s105", passwordHash: await hasher.hash(PASSWORD), staffId: "S105", name: "Aarav P.", role: "salesperson", storeCodes: ["HSR"], active: true, ...over }, "2026-10-28T00:00:00Z");
}

describe("ScryptHasher", () => {
  it("never stores the password, salts every hash, and verifies only the right one", async () => {
    const a = await hasher.hash(PASSWORD);
    const b = await hasher.hash(PASSWORD);
    expect(a).not.toContain(PASSWORD);
    expect(a).toMatch(/^scrypt\$10\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await hasher.verify(PASSWORD, a)).toBe(true);
    expect(await hasher.verify(PASSWORD + "x", a)).toBe(false);
    expect(await hasher.verify(PASSWORD, "plaintext")).toBe(false);
    expect(await hasher.verify(PASSWORD, "scrypt$10$8$1$")).toBe(false);
  });

  it("verifies a hash made at another cost (so the cost can be raised later)", async () => {
    expect(await hasher.verify(PASSWORD, await new ScryptHasher(11).hash(PASSWORD))).toBe(true);
  });
});

describe("AuthService", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(async () => {
    s = setup();
    await addUser(s);
  });

  it("logs in with the right password: identity and role come from the stored user", async () => {
    const r = await s.auth.login(" S105 ", PASSWORD); // username is case-insensitive and trimmed
    expect(r.principal).toEqual({ userId: "usr_S105", username: "s105", staffId: "S105", name: "Aarav P.", role: "salesperson", storeCodes: ["HSR"] });
    expect(r.sessionToken.length).toBeGreaterThanOrEqual(40);
    expect(s.auth.authenticate(r.sessionToken)?.principal.staffId).toBe("S105");
    expect(s.audit.map((e) => e.action)).toEqual(["auth.login"]);
  });

  it("stores only a hash of the session token, so a database copy cannot be replayed", async () => {
    const r = await s.auth.login("s105", PASSWORD);
    const rows = s.db.prepare("SELECT session_hash FROM sessions").all() as { session_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_hash).not.toBe(r.sessionToken);
    expect(s.auth.authenticate(rows[0]!.session_hash)).toBeNull();
  });

  it("wrong password and unknown user fail identically, and are audited", async () => {
    const wrong = await s.auth.login("s105", "nope").catch((e: unknown) => e);
    const unknown = await s.auth.login("ghost", PASSWORD).catch((e: unknown) => e);
    expect(wrong).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Wrong username or password." });
    expect(unknown).toMatchObject({ code: "INVALID_CREDENTIALS", message: "Wrong username or password." });
    expect(s.audit.filter((e) => e.action === "auth.login_failed")).toHaveLength(2);
  });

  it("a disabled account cannot sign in, and its open sessions stop working", async () => {
    const r = await s.auth.login("s105", PASSWORD);
    s.users.deactivateExcept([], "2026-10-28T09:01:00Z");
    expect(s.auth.authenticate(r.sessionToken)).toBeNull();
    await expect(s.auth.login("s105", PASSWORD)).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("a session expires after the idle window, and activity slides it", async () => {
    const r = await s.auth.login("s105", PASSWORD);
    now += minutes(100);
    expect(s.auth.authenticate(r.sessionToken)).not.toBeNull(); // used at +100 min: the window slides
    now += minutes(100);
    expect(s.auth.authenticate(r.sessionToken)).not.toBeNull(); // +200 min total, but never idle for 120
    now += minutes(121);
    expect(s.auth.authenticate(r.sessionToken)).toBeNull(); // idle too long
  });

  it("a session expires at the absolute limit however active the user is", async () => {
    const r = await s.auth.login("s105", PASSWORD);
    for (let i = 0; i < 11; i++) {
      now += minutes(60);
      expect(s.auth.authenticate(r.sessionToken), `hour ${i + 1}`).not.toBeNull();
    }
    now += minutes(60); // 12 h after login
    expect(s.auth.authenticate(r.sessionToken)).toBeNull();
  });

  it("logout ends the session on the server", async () => {
    const r = await s.auth.login("s105", PASSWORD);
    s.auth.logout(r.sessionToken);
    expect(s.auth.authenticate(r.sessionToken)).toBeNull();
    expect(s.audit.map((e) => e.action)).toContain("auth.logout");
  });

  it("garbage and missing tokens are not sessions", () => {
    expect(s.auth.authenticate(undefined)).toBeNull();
    expect(s.auth.authenticate("")).toBeNull();
    expect(s.auth.authenticate("not-a-token")).toBeNull();
  });

  it("locks a username after repeated failures, even for the right password, then recovers", async () => {
    for (let i = 0; i < 5; i++) await s.auth.login("s105", "bad").catch(() => undefined);
    const locked = await s.auth.login("s105", PASSWORD).catch((e: unknown) => e);
    expect(locked).toMatchObject({ code: "TOO_MANY_LOGINS", details: { retryAfterSeconds: 900 } });
    now += minutes(16);
    expect((await s.auth.login("s105", PASSWORD)).principal.staffId).toBe("S105");
  });

  it("old failures do not add up forever", async () => {
    for (let i = 0; i < 4; i++) await s.auth.login("s105", "bad").catch(() => undefined);
    now += minutes(20);
    await s.auth.login("s105", "bad").catch(() => undefined); // a fresh window: 1 failure, not 5
    expect((await s.auth.login("s105", PASSWORD)).principal.staffId).toBe("S105");
  });
});

describe("provisionUsers", () => {
  const staff: Staff[] = [
    { staffId: "S105", name: "Aarav P.", role: "sales", storeCode: "HSR", badges: [], canOverrideDiscount: false },
    { staffId: "S107", name: "Dr. Iyer", role: "optometrist", storeCode: "HSR", badges: [], canOverrideDiscount: false },
    { staffId: "S108", name: "Meera P.", role: "store_manager", storeCode: "HSR", badges: [], canOverrideDiscount: true },
    { staffId: "S900", name: "HQ person", role: "sales", storeCode: "HQ", badges: [], canOverrideDiscount: false },
  ];
  const stores = { listStores: async () => [{ code: "HSR" } as Store] };

  it("creates salespeople and managers only: optometrists and non-billing locations get no login", async () => {
    const users = new SqliteUserRepository(openDb(":memory:"));
    const r = await provisionUsers({ roster: { listAll: async () => staff }, stores, users, hasher, clock, password: PASSWORD });
    expect(r).toEqual({ created: 2, updated: 0, unchanged: 0, deactivated: 0 });
    expect(users.findByUsername("s105")).toMatchObject({ role: "salesperson", storeCodes: ["HSR"] });
    expect(users.findByUsername("s108")).toMatchObject({ role: "store_manager", storeCodes: ["HSR"] });
    expect(users.findByUsername("s107")).toBeNull();
    expect(users.findByUsername("s900")).toBeNull();
    expect(users.findByUsername("s105")!.passwordHash).not.toContain(PASSWORD);
  });

  it("is repeatable, rotates a changed password, and disables staff who left the roster", async () => {
    const users = new SqliteUserRepository(openDb(":memory:"));
    const run = (password: string, roster = staff) => provisionUsers({ roster: { listAll: async () => roster }, stores, users, hasher, clock, password });
    await run(PASSWORD);
    expect(await run(PASSWORD)).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect(await run("another long password 99")).toMatchObject({ updated: 2 });
    expect(await hasher.verify("another long password 99", users.findByUsername("s105")!.passwordHash)).toBe(true);
    expect(await run("another long password 99", staff.filter((x) => x.staffId !== "S105"))).toMatchObject({ deactivated: 1 });
    expect(users.findByUsername("s105")!.active).toBe(false);
  });

  it("refuses a short password", async () => {
    await expect(provisionUsers({ roster: { listAll: async () => staff }, stores, users: new SqliteUserRepository(openDb(":memory:")), hasher, clock, password: "short" })).rejects.toThrow(/at least 12/);
  });
});
