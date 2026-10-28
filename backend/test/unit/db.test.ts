import { describe, expect, it } from "vitest";
import { openDb } from "../../src/adapters/sqlite/db.js";

describe("openDb", () => {
  it("applies all migrations", () => {
    const db = openDb(":memory:");
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["audit_events", "carts", "invoice_series", "invoices", "sessions", "till_movements", "till_sessions", "users"]),
    );
  });

  it("allows only one open till session per store", () => {
    const db = openDb(":memory:");
    const open = db.prepare(
      "INSERT INTO till_sessions (session_id, location_id, store_code, opened_by, opened_at, float_paise) VALUES (?, 70000002, 'HSR', 'S105', '2026-10-23T10:00:00+05:30', 300000)",
    );
    open.run("T1");
    expect(() => open.run("T2")).toThrow(/UNIQUE/);
  });
});
