import { flagsOf, checkCustomerDetails, type Customer, type CustomerFlags } from "../domain/customer.js";
import { DomainError } from "../domain/errors.js";
import { normalizeIndianMobile } from "../domain/phone.js";
import { newestFirst, rxStatus, type Prescription, type RxStatus } from "../domain/prescription.js";
import type { BillStatus } from "../domain/bill.js";
import { CustomerConflict, CustomerRejected, type AuditLog, type BillRepository, type Clock, type CustomerDirectory, type CustomerRegistry, type PrescriptionIndex } from "../ports/index.js";

export const MAX_PAGE = 50;
export const DEFAULT_PAGE = 20;

/** One row of the customer list: who they are, and (when the store tool answers) where their prescriptions stand. */
export interface CustomerRow {
  customer: Customer;
  flags: CustomerFlags;
  /** null when the store tool could not be reached: the row still shows, the summary says "unavailable". */
  prescriptions: RxSummary | null;
}

export interface RxSummary {
  count: number;
  latest: { rxId: string; testedOn: string; validUntil: string; status: RxStatus } | null;
}

export interface CustomerPage {
  items: CustomerRow[];
  nextCursor: string | null;
}

export interface BillRow {
  invoiceNo: string;
  status: BillStatus;
  storeCode: string;
  invoiceDate: string;
  createdAt: string;
  payablePaise: number;
}

export function summarise(customerId: string, all: readonly Prescription[], today: string): RxSummary {
  const mine = all.filter((r) => r.customerId === customerId).sort(newestFirst);
  const latest = mine[0];
  return { count: mine.length, latest: latest ? { rxId: latest.rxId, testedOn: latest.testedOn, validUntil: latest.validUntil, status: rxStatus(latest, today) } : null };
}

/** Browse, open and edit customers. Shopify stays the system of record: nothing here is copied into the till's own database. */
export class Customers {
  constructor(
    private readonly d: {
      customers: CustomerDirectory & CustomerRegistry;
      prescriptions: PrescriptionIndex;
      bills: BillRepository;
      audit: AuditLog;
      clock: Clock;
    },
  ) {}

  /** A page of customers, searched by name, email or phone. The browser never receives more than one page. */
  async list(q: { text?: string; cursor?: string; limit?: number }): Promise<CustomerPage> {
    const limit = Math.min(Math.max(q.limit ?? DEFAULT_PAGE, 1), MAX_PAGE);
    const text = (q.text ?? "").trim().slice(0, 80);
    const { customers, nextCursor } = await this.d.customers.search({ text, ...(q.cursor ? { afterId: q.cursor } : {}), limit });

    let rx: Prescription[] | null = null;
    try {
      rx = await this.d.prescriptions.listByPhones(customers.map((c) => c.phone).filter(Boolean));
    } catch {
      rx = null; // a slow store tool must not take the customer list down with it
    }
    const today = this.d.clock.today();
    return {
      items: customers.map((customer) => ({ customer, flags: flagsOf(customer), prescriptions: rx ? summarise(customer.id, rx, today) : null })),
      nextCursor,
    };
  }

  async get(id: string): Promise<Customer> {
    const c = await this.d.customers.getById(id);
    if (!c) throw new DomainError("CUSTOMER_NOT_FOUND", `No customer ${id}.`, { customerId: id });
    return c;
  }

  /**
   * Edit contact details. The phone number is the key prescriptions and bills are found by, so it cannot change here:
   * sending the same number is fine, a different one is refused. Prescriptions are never touched.
   */
  async update(id: string, input: { firstName?: string; lastName?: string; email?: string | null; phone?: string }, staffId: string): Promise<Customer> {
    const current = await this.get(id);
    if (input.phone !== undefined && normalizeIndianMobile(input.phone) !== current.phone) {
      throw new DomainError("CUSTOMER_INVALID", "The mobile number cannot be changed here: prescriptions and bills are found by it.", { fields: { phone: "The mobile number cannot be changed here." } });
    }
    const checked = checkCustomerDetails({ firstName: input.firstName ?? current.firstName, lastName: input.lastName ?? current.lastName, email: input.email === undefined ? (current.email ?? null) : input.email });
    if (!checked.ok) throw new DomainError("CUSTOMER_INVALID", Object.values(checked.fields).join(" "), { fields: checked.fields });

    const next = checked.value;
    const changed = (["firstName", "lastName", "email"] as const).filter((k) => (next[k] ?? "") !== (k === "email" ? (current.email ?? "") : current[k]));
    if (changed.length === 0) return current;

    let updated: Customer;
    try {
      updated = await this.d.customers.updateCustomer(id, next);
    } catch (e) {
      if (e instanceof CustomerConflict) throw new DomainError("CUSTOMER_EXISTS", "Another customer already has this email address.", { fields: { email: "Another customer already has this email address." } });
      if (e instanceof CustomerRejected) throw new DomainError("CUSTOMER_INVALID", "Shopify did not accept these details. Check the name and email.", { fields: {} });
      throw e;
    }
    // Which fields changed, not their values: the audit log holds no customer data beyond the id.
    this.d.audit.record({ at: this.d.clock.now().toISOString(), staffId, action: "customer.updated", ref: `customer:${id}`, payload: { fields: changed } });
    return updated;
  }

  /** The customer's bills at the stores the caller works in, newest first. */
  async bills(id: string, storeCodes: readonly string[], limit = 10): Promise<BillRow[]> {
    await this.get(id);
    return storeCodes
      .flatMap((code) => this.d.bills.listForStore(code))
      .filter((b) => b.customer.id === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((b) => ({ invoiceNo: b.invoiceNo, status: b.status, storeCode: b.store.code, invoiceDate: b.invoiceDate, createdAt: b.createdAt, payablePaise: b.totals.payablePaise }));
  }
}
