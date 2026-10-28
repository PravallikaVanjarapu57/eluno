import { DomainError } from "../domain/errors.js";
import { normalizeIndianMobile } from "../domain/phone.js";
import { checkCustomerDetails, type Customer } from "../domain/customer.js";
import { CustomerAlreadyExists, CustomerOutcomeUnknown, CustomerRejected, type AuditLog, type Clock, type CustomerDirectory, type CustomerRegistry } from "../ports/index.js";
import type { CustomerLookup, LookupCustomer } from "./lookupCustomer.js";

export interface CreateCustomerInput {
  phone: string;
  firstName: string;
  lastName?: string;
  email?: string;
}

/**
 * Create a billing customer. The phone is the key everything else uses, so it must stay unique:
 *  - look first, so the common duplicate is refused without a write;
 *  - Shopify refuses a taken phone itself, which is what settles a race between two tills;
 *  - an uncertain write (timeout, 5xx) is resolved by looking the phone up, never by blindly writing again;
 *  - two requests for the same phone in this process share one write.
 */
export class CreateCustomer {
  private readonly inflight = new Map<string, Promise<Customer>>();

  constructor(
    private readonly d: {
      customers: CustomerDirectory & CustomerRegistry;
      lookup: LookupCustomer;
      audit: AuditLog;
      clock: Clock;
    },
  ) {}

  async create(input: CreateCustomerInput, staffId: string): Promise<CustomerLookup> {
    const phone = normalizeIndianMobile(input.phone);
    const checked = checkCustomerDetails(input);
    if (!checked.ok) throw new DomainError("CUSTOMER_INVALID", Object.values(checked.fields).join(" "), { fields: checked.fields });
    const { firstName, lastName, email } = checked.value;

    // A second request for the same phone while the first is writing waits for it, then takes the normal path:
    // the customer now exists, so it is refused as a duplicate; if the first failed, it simply tries itself.
    const running = this.inflight.get(phone);
    if (running) await running.catch(() => undefined);
    const run = this.createOnce({ phone, firstName, lastName, ...(email ? { email } : {}) });
    this.inflight.set(phone, run);
    let customer: Customer;
    try {
      customer = await run;
    } finally {
      this.inflight.delete(phone);
    }
    this.d.audit.record({ at: this.d.clock.now().toISOString(), staffId, action: "customer.created", ref: `customer:${customer.id}`, payload: { phone } });
    return this.d.lookup.forCustomer(customer);
  }

  private async createOnce(input: { phone: string; firstName: string; lastName: string; email?: string }): Promise<Customer> {
    const already = await this.d.customers.findByPhone(input.phone);
    if (already.length > 0) throw this.exists(already[0]!);
    try {
      return await this.d.customers.createCustomer(input);
    } catch (e) {
      if (e instanceof CustomerAlreadyExists) throw await this.existing(input.phone); // lost a race with another till
      if (e instanceof CustomerRejected) throw new DomainError("CUSTOMER_INVALID", "Shopify did not accept these customer details. Check the name, phone and email.", { reason: e.message });
      if (e instanceof CustomerOutcomeUnknown) {
        // The write may have landed. If the phone is there now, that is our customer.
        const found = await this.d.customers.findByPhone(input.phone);
        if (found.length === 1) return found[0]!;
      }
      throw e;
    }
  }

  private async existing(phone: string): Promise<DomainError> {
    const found = await this.d.customers.findByPhone(phone);
    return found.length > 0 ? this.exists(found[0]!) : new DomainError("CUSTOMER_EXISTS", `A customer with phone ${phone} already exists.`, { phone });
  }

  private exists(c: Customer): DomainError {
    const name = `${c.firstName} ${c.lastName}`.trim();
    return new DomainError("CUSTOMER_EXISTS", `${name || "A customer"} (${c.phone}) already exists. Look them up instead of creating a new one.`, { phone: c.phone, customerId: c.id });
  }
}
