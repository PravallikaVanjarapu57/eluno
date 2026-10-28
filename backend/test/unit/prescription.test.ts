import { describe, expect, it } from "vitest";
import { selectPrescription, warningsFor, type Prescription } from "../../src/domain/prescription.js";

const eye = { sph: -2, cyl: 0, axis: null, add: null };
const rx = (id: string, testedOn: string, validUntil: string, extra: Partial<Prescription> = {}): Prescription => ({
  rxId: id, customerId: "C1", testedOn, validUntil, source: "in_store", optometristId: "S103",
  od: eye, os: eye, pd: { binocular: 62, monoR: null, monoL: null }, notes: null, ...extra,
});
const TODAY = "2026-10-23";

describe("selectPrescription", () => {
  it("picks the most recent prescription in force, whatever order upstream sends", () => {
    const sel = selectPrescription("C1", [rx("A", "2025-03-07", "2026-03-07"), rx("B", "2026-06-11", "2027-06-11"), rx("C", "2024-06-09", "2025-06-09")], TODAY);
    expect(sel.status).toBe("valid");
    if (sel.status !== "valid") return;
    expect(sel.rx.rxId).toBe("B");
    expect(sel.skipped.map((s) => s.rxId).sort()).toEqual(["A", "C"]);
  });

  it("ignores a prescription dated in the future (seed: RX5044 dated 2027-01-10)", () => {
    const sel = selectPrescription("C1", [rx("RX5044", "2027-01-10", "2028-01-10"), rx("RX5043", "2026-10-01", "2027-10-01")], TODAY);
    expect(sel).toMatchObject({ status: "valid", rx: { rxId: "RX5043" } });
    expect(sel.skipped).toContainEqual({ rxId: "RX5044", reason: expect.stringMatching(/in the future/) });
  });

  it("is still valid on its last day and expired the day after", () => {
    expect(selectPrescription("C1", [rx("A", "2025-10-23", "2026-10-23")], TODAY).status).toBe("valid");
    expect(selectPrescription("C1", [rx("A", "2025-10-22", "2026-10-22")], TODAY).status).toBe("expired");
  });

  it("reports expiry with an action for staff (seed: RX5001 expired 2026-07-16)", () => {
    const sel = selectPrescription("C1", [rx("RX5001", "2025-07-16", "2026-07-16")], TODAY);
    expect(sel).toMatchObject({ status: "expired", latest: { rxId: "RX5001" } });
    if (sel.status === "expired") expect(sel.reason).toMatch(/expired on 2026-07-16.*Book an eye test/);
  });

  it("only future and expired ones -> expired, pointing at the latest past test (seed: customer 80001012)", () => {
    const sel = selectPrescription(
      "C1",
      [rx("RX5018", "2026-11-29", "2027-11-29"), rx("RX5019", "2025-05-25", "2026-05-25"), rx("RX5017", "2025-01-20", "2026-01-20")],
      TODAY,
    );
    expect(sel).toMatchObject({ status: "expired", latest: { rxId: "RX5019" } });
  });

  it("none on file", () => {
    expect(selectPrescription("C1", [], TODAY)).toMatchObject({ status: "none_on_file", reason: expect.stringMatching(/eye test/) });
  });

  it("never uses another customer's prescription even on the same phone", () => {
    const sel = selectPrescription("C1", [rx("X", "2026-06-11", "2027-06-11", { customerId: "C2" })], TODAY);
    expect(sel.status).toBe("none_on_file");
    expect(sel.skipped).toEqual([{ rxId: "X", reason: "belongs to another customer on this phone" }]);
  });
});

describe("warningsFor", () => {
  it("flags external prescriptions and axes off the 5° grid (seed: RX5999 axis 87/92)", () => {
    const w = warningsFor(rx("RX5999", "2026-09-30", "2027-09-30", {
      source: "external", optometristId: null,
      od: { sph: -2.25, cyl: -0.75, axis: 87, add: null },
      os: { sph: -2, cyl: -0.5, axis: 92, add: null },
    }));
    expect(w).toHaveLength(3);
    expect(w[1]).toMatch(/right eye \(OD\) axis 87°/);
    expect(w[2]).toMatch(/left eye \(OS\) axis 92°/);
  });

  it("stays quiet for an in-store prescription on the grid", () => {
    expect(warningsFor(rx("A", "2026-01-01", "2027-01-01", { od: { sph: -1, cyl: -0.5, axis: 90, add: null } }))).toEqual([]);
  });
});

import { checkNewPrescription, rxStatus } from "../../src/domain/prescription.js";

describe("rxStatus", () => {
  it("is valid through its last day, expired after, and future_dated before the test", () => {
    expect(rxStatus({ testedOn: "2025-10-23", validUntil: "2026-10-23" }, TODAY)).toBe("valid");
    expect(rxStatus({ testedOn: "2025-10-22", validUntil: "2026-10-22" }, TODAY)).toBe("expired");
    expect(rxStatus({ testedOn: "2026-10-24", validUntil: "2027-10-24" }, TODAY)).toBe("future_dated");
  });
});

describe("checkNewPrescription", () => {
  const ok = { testedOn: "2026-10-23", od: { sph: -1.5, cyl: -0.5, axis: 90 }, os: { sph: 0 } };
  it("defaults the expiry to a year after the test and stores staff entries as external", () => {
    const r = checkNewPrescription("C1", ok, TODAY);
    expect(r).toMatchObject({ ok: true, value: { validUntil: "2027-10-23", source: "external", optometristId: null, od: { sph: -1.5, cyl: -0.5, axis: 90, add: null }, os: { sph: 0, cyl: 0, axis: null } } });
  });
  it("handles a leap day when adding a year", () => {
    expect(checkNewPrescription("C1", { ...ok, testedOn: "2024-02-29" }, TODAY)).toMatchObject({ ok: true, value: { validUntil: "2025-02-28" } });
  });
  it("reports every problem at once, by field", () => {
    const r = checkNewPrescription("C1", { testedOn: "nope", od: { sph: 0.1 }, os: { sph: 1, cyl: -1 } }, TODAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fields).sort()).toEqual(["od.sph", "os.axis", "testedOn", "validUntil"].sort());
  });
});
