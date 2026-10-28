import { describe, expect, it } from "vitest";
import { Customers, summarise } from "../../src/application/customers.js";
import type { Customer } from "../../src/domain/customer.js";
import type { Prescription } from "../../src/domain/prescription.js";

const clock = { now: () => new Date("2026-10-23T05:00:00Z"), today: () => "2026-10-23" };
const cust = (id: string, phone: string): Customer => ({ id, firstName: "A", lastName: id, phone, tags: [], lifetimeSpendPaise: 0, ordersCount: 0 });
const eye = { sph: -1, cyl: 0, axis: null, add: null };
const rx = (rxId: string, customerId: string, testedOn: string, validUntil: string): Prescription => ({ rxId, customerId, testedOn, validUntil, source: "external", optometristId: null, od: eye, os: eye, pd: { binocular: null, monoR: null, monoL: null }, notes: null });

describe("summarise", () => {
  it("counts only this customer's prescriptions and reports the newest one's status", () => {
    const all = [rx("A", "1", "2025-01-01", "2026-01-01"), rx("B", "1", "2026-09-01", "2027-09-01"), rx("C", "2", "2026-10-01", "2027-10-01")];
    expect(summarise("1", all, "2026-10-23")).toEqual({ count: 2, latest: { rxId: "B", testedOn: "2026-09-01", validUntil: "2027-09-01", status: "valid" } });
    expect(summarise("9", all, "2026-10-23")).toEqual({ count: 0, latest: null });
  });
});

describe("Customers.list", () => {
  const base = (fail: boolean) =>
    new Customers({
      customers: { search: async () => ({ customers: [cust("1", "+919000000001")], nextCursor: "1" }) } as never,
      prescriptions: { listByPhones: async () => { if (fail) throw new Error("store tool down"); return [rx("A", "1", "2026-10-01", "2027-10-01")]; } },
      bills: {} as never,
      audit: { record: () => {}, forRef: () => [] },
      clock,
    });

  it("shows the customers with their prescription summary", async () => {
    const page = await base(false).list({});
    expect(page.nextCursor).toBe("1");
    expect(page.items[0]!.prescriptions).toMatchObject({ count: 1, latest: { status: "valid" } });
  });

  it("still lists customers when the store tool is down; the summary is null, not an error", async () => {
    const page = await base(true).list({});
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.prescriptions).toBeNull();
  });
});
