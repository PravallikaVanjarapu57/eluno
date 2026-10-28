import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDbFiles } from "../../scripts/resetDb.js";

function dbIn(dir: string) {
  const db = path.join(dir, "till.db");
  for (const s of ["", "-shm", "-wal"]) writeFileSync(db + s, "x");
  return db;
}

describe("resetDbFiles", () => {
  it("removes the database and its WAL files when enabled", () => {
    const db = dbIn(mkdtempSync(path.join(tmpdir(), "reset-")));
    expect(resetDbFiles(db, true)).toEqual([db, db + "-shm", db + "-wal"]);
    expect(existsSync(db)).toBe(false);
    expect(existsSync(db + "-wal")).toBe(false);
  });

  it("leaves everything alone when not enabled (local development keeps its data)", () => {
    const db = dbIn(mkdtempSync(path.join(tmpdir(), "reset-")));
    expect(resetDbFiles(db, false)).toEqual([]);
    expect(existsSync(db)).toBe(true);
  });

  it("is fine when there is nothing to remove, and never touches :memory:", () => {
    expect(resetDbFiles(path.join(tmpdir(), "does-not-exist.db"), true)).toEqual([]);
    expect(resetDbFiles(":memory:", true)).toEqual([]);
  });
});
