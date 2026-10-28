import { describe, expect, it } from "vitest";
import { CreateCustomer } from "../../src/application/createCustomer.js";
import { LookupCustomer } from "../../src/application/lookupCustomer.js";
import type { Customer } from "../../src/domain/customer.js";
import { DomainError } from "../../src/domain/errors.js";
import { CustomerAlreadyExists, CustomerOutcomeUnknown, CustomerRejected, type AuditEvent, type NewCustomer } from "../../src/ports/index.js";

const clock = { now: () => new Date("2026-10-28T05:00:00Z"), today: () => "2026-10-28" };

class FakeShopify {
  customers: Customer[] = [];
  creates: NewCustomer[] = [];
  /** What the next createCustomer does instead of succeeding. */
  next: ((input: NewCustomer) => Promise<Customer>) | null = null;
  private seq = 100;
  async findByPhone(phone: string) {
    return this.customers.filter((c) => c.phone === phone);
  }
  async getById(id: string) {
    return this.customers.find((c) => c.id === id) ?? null;
  }
  async search() {
    return { customers: this.customers, nextCursor: null };
  }
  async updateCustomer(id: string, patch: { firstName: string; lastName: string; email: string | null }): Promise<Customer> {
    const c = this.customers.find((x) => x.id === id)!;
    Object.assign(c, patch);
    return c;
  }
  async createCustomer(input: NewCustomer): Promise<Customer> {
    this.creates.push(input);
    if (this.next) return this.next(input);
    return this.add(input);
  }
  add(input: NewCustomer): Customer {
    const c: Customer = { id: String(++this.seq), firstName: input.firstName, lastName: input.lastName, phone: input.phone, tags: [], lifetimeSpendPaise: 0, ordersCount: 0 };
    this.customers.push(c);
    return c;
  }
}

function setup(rxLookup: () => Promise<never[]> = async () => []) {
  const shopify = new FakeShopify();
  const audit: AuditEvent[] = [];
  const lookup = new LookupCustomer(shopify, { listByPhone: rxLookup }, clock);
  const svc = new CreateCustomer({ customers: shopify, lookup, audit: { record: (e) => void audit.push(e), forRef: () => [] }, clock });
  return { shopify, audit, svc };
}

const input = { phone: "90000 12345", firstName: " Asha ", lastName: "Menon" };

describe("CreateCustomer", () => {
  it("creates the customer with a normalised phone and returns the billing view (no prescription yet)", async () => {
    const { shopify, audit, svc } = setup();
    const out = await svc.create(input, "S105");
    expect(shopify.creates).toEqual([{ phone: "+919000012345", firstName: "Asha", lastName: "Menon" }]);
    expect(out.customer).toMatchObject({ firstName: "Asha", lastName: "Menon", phone: "+919000012345", ordersCount: 0 });
    expect(out.flags).toEqual({ priority: false, family: false, campaigns: [] });
    expect(out.prescription.status).toBe("none_on_file");
    expect(audit).toEqual([expect.objectContaining({ staffId: "S105", action: "customer.created", ref: `customer:${out.customer.id}` })]);
  });

  it("rejects a bad phone and a missing first name before any write", async () => {
    const { shopify, svc } = setup();
    await expect(svc.create({ ...input, phone: "12345" }, "S105")).rejects.toMatchObject({ code: "INVALID_PHONE" });
    await expect(svc.create({ ...input, firstName: "   " }, "S105")).rejects.toMatchObject({ code: "CUSTOMER_INVALID" });
    expect(shopify.creates).toHaveLength(0);
  });

  it("refuses a duplicate phone without writing, and says who already has it", async () => {
    const { shopify, svc } = setup();
    shopify.add({ phone: "+919000012345", firstName: "Ravi", lastName: "K" });
    const err = await svc.create(input, "S105").catch((e: unknown) => e as DomainError);
    expect(err).toMatchObject({ code: "CUSTOMER_EXISTS", details: { phone: "+919000012345" } });
    expect((err as DomainError).message).toMatch(/Ravi K/);
    expect(shopify.creates).toHaveLength(0);
  });

  it("a lost race (Shopify says the phone is taken) becomes CUSTOMER_EXISTS, not an error", async () => {
    const { shopify, svc } = setup();
    shopify.next = async (i) => {
      shopify.add(i); // the other till's write lands first
      throw new CustomerAlreadyExists("taken");
    };
    await expect(svc.create(input, "S105")).rejects.toMatchObject({ code: "CUSTOMER_EXISTS" });
    expect(shopify.customers).toHaveLength(1);
  });

  it("two simultaneous requests for one phone: one customer, the other told it exists", async () => {
    const { shopify, svc } = setup();
    const results = await Promise.allSettled([svc.create(input, "S105"), svc.create(input, "S106")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ code: "CUSTOMER_EXISTS" });
    expect(shopify.creates).toHaveLength(1);
    expect(shopify.customers).toHaveLength(1);
  });

  it("an uncertain write that did land is adopted, not repeated", async () => {
    const { shopify, svc } = setup();
    shopify.next = async (i) => {
      shopify.add(i);
      throw new CustomerOutcomeUnknown("timeout");
    };
    const out = await svc.create(input, "S105");
    expect(out.customer.phone).toBe("+919000012345");
    expect(shopify.creates).toHaveLength(1);
    expect(shopify.customers).toHaveLength(1);
  });

  it("an uncertain write that did not land is surfaced, so staff can try again", async () => {
    const { shopify, svc } = setup();
    shopify.next = async () => {
      throw new CustomerOutcomeUnknown("timeout");
    };
    await expect(svc.create(input, "S105")).rejects.toBeInstanceOf(CustomerOutcomeUnknown);
    expect(shopify.customers).toHaveLength(0);
  });

  it("Shopify refusing the data becomes a 422-style CUSTOMER_INVALID", async () => {
    const { shopify, svc } = setup();
    shopify.next = async () => {
      throw new CustomerRejected("email is invalid");
    };
    await expect(svc.create(input, "S105")).rejects.toMatchObject({ code: "CUSTOMER_INVALID" });
  });

  it("the store tool being down does not undo a successful creation", async () => {
    const { svc } = setup(async () => {
      throw new Error("smt down");
    });
    const out = await svc.create(input, "S105");
    expect(out.prescription.status).toBe("unavailable");
  });
});
