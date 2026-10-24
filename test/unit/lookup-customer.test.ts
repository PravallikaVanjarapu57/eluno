import { describe, expect, it } from "vitest";
import { LookupCustomer } from "../../src/application/lookupCustomer.js";
import type { Customer } from "../../src/domain/customer.js";
import type { Prescription } from "../../src/domain/prescription.js";
import type { Clock, CustomerDirectory, PrescriptionSource } from "../../src/ports/index.js";

const karthik: Customer = {
  id: "80001005", firstName: "Karthik", lastName: "Reddy", phone: "+919000000005",
  tags: ["campaign:progressive_oct26", "priority"], lifetimeSpendPaise: 1849900, ordersCount: 2,
};
const eye = { sph: -3.25, cyl: 0, axis: null, add: 2.5 };
const rx5007: Prescription = {
  rxId: "RX5007", customerId: "80001005", testedOn: "2026-07-10", validUntil: "2027-07-10", source: "in_store",
  optometristId: "S106", od: eye, os: eye, pd: { binocular: 63, monoR: null, monoL: null }, notes: null,
};
const clock: Clock = { now: () => new Date(), today: () => "2026-10-23" };

function useCase(customers: Customer[], rxs: Prescription[] | Error) {
  const phones: string[] = [];
  const dir: CustomerDirectory = { findByPhone: async (p) => (phones.push(p), customers) };
  const src: PrescriptionSource = { listByPhone: async () => { if (rxs instanceof Error) throw rxs; return rxs; } };
  return { lookup: new LookupCustomer(dir, src, clock), phones };
}

describe("LookupCustomer", () => {
  it("returns the customer, billing flags and the prescription to bill against", async () => {
    const { lookup, phones } = useCase([karthik], [rx5007]);
    const out = await lookup.byPhone("90000 00005");
    expect(phones).toEqual(["+919000000005"]);
    expect(out.flags).toEqual({ priority: true, family: false, campaigns: ["progressive_oct26"] });
    expect(out.prescription).toMatchObject({ status: "valid", rx: { rxId: "RX5007" } });
  });

  it("still returns the customer when the store tool is down", async () => {
    const { lookup } = useCase([karthik], new Error("ECONNREFUSED"));
    const out = await lookup.byPhone("9000000005");
    expect(out.customer.id).toBe("80001005");
    expect(out.prescription).toMatchObject({ status: "unavailable" });
  });

  it("not found", async () => {
    await expect(useCase([], []).lookup.byPhone("9000000099")).rejects.toMatchObject({ code: "CUSTOMER_NOT_FOUND" });
  });

  it("refuses to guess between duplicate customers", async () => {
    await expect(useCase([karthik, { ...karthik, id: "2" }], []).lookup.byPhone("9000000005")).rejects.toMatchObject({
      code: "CUSTOMER_AMBIGUOUS",
      details: { customerIds: ["80001005", "2"] },
    });
  });

  it("rejects a malformed phone before calling anything", async () => {
    const { lookup, phones } = useCase([karthik], []);
    await expect(lookup.byPhone("123")).rejects.toMatchObject({ code: "INVALID_PHONE" });
    expect(phones).toEqual([]);
  });
});
