import { flagsOf, type Customer, type CustomerFlags } from "../domain/customer.js";
import { DomainError } from "../domain/errors.js";
import { normalizeIndianMobile } from "../domain/phone.js";
import { selectPrescription, type RxSelection } from "../domain/prescription.js";
import type { Clock, CustomerDirectory, PrescriptionSource } from "../ports/index.js";

export type PrescriptionLookup = RxSelection | { status: "unavailable"; reason: string };

export interface CustomerLookup {
  customer: Customer;
  flags: CustomerFlags;
  prescription: PrescriptionLookup;
}

export class LookupCustomer {
  constructor(
    private readonly customers: CustomerDirectory,
    private readonly prescriptions: PrescriptionSource,
    private readonly clock: Clock,
  ) {}

  async byPhone(rawPhone: string): Promise<CustomerLookup> {
    const phone = normalizeIndianMobile(rawPhone);
    // Both upstreams are keyed by phone, so ask them in parallel.
    const [found, rxs] = await Promise.all([
      this.customers.findByPhone(phone),
      this.prescriptions.listByPhone(phone).then(
        (list) => ({ ok: true as const, list }),
        (err: unknown) => ({ ok: false as const, err }),
      ),
    ]);

    if (found.length === 0) {
      throw new DomainError("CUSTOMER_NOT_FOUND", `No customer with phone ${phone}. Create them in Shopify first.`, { phone });
    }
    if (found.length > 1) {
      throw new DomainError("CUSTOMER_AMBIGUOUS", `${found.length} customers share phone ${phone}. Merge them in Shopify before billing.`, {
        phone,
        customerIds: found.map((c) => c.id),
      });
    }
    const customer = found[0]!;

    // The store tool being down must not hide the customer: frames and sunglasses can still be billed.
    const prescription: PrescriptionLookup = rxs.ok
      ? selectPrescription(customer.id, rxs.list, this.clock.today())
      : { status: "unavailable", reason: "Store tool is not responding; prescriptions cannot be loaded right now. Lens billing is blocked until it is back." };

    return { customer, flags: flagsOf(customer), prescription };
  }
}
