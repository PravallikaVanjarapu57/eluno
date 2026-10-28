import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { Customer } from "../domain/customer.js";
import { checkNewPrescription, newestFirst, rxStatus, warningsFor, type NewPrescriptionInput, type Prescription, type RxStatus } from "../domain/prescription.js";
import { PrescriptionRejected, type AuditLog, type Clock, type CustomerDirectory, type PrescriptionRegistry, type PrescriptionSource } from "../ports/index.js";

export interface PrescriptionView {
  rx: Prescription;
  status: RxStatus;
  /** Things to double-check before billing; never blocking. */
  warnings: string[];
  /** Whether a lens can be billed against it today. The rule is the one addPair applies at the cart. */
  eligible: boolean;
  /** Why not, in words for staff; null when eligible. */
  reason: string | null;
}

const reasonFor = (rx: Prescription, status: RxStatus): string | null =>
  status === "valid" ? null : status === "expired" ? `Expired on ${rx.validUntil}. Book an eye test before billing a lens.` : `Dated ${rx.testedOn}, in the future. Check the entry.`;

/** Prescriptions of a customer: read from, and recorded in, the store tool. Nothing is edited or deleted, so history is kept. */
export class Prescriptions {
  constructor(
    private readonly d: {
      customers: CustomerDirectory;
      source: PrescriptionSource;
      registry: PrescriptionRegistry;
      audit: AuditLog;
      clock: Clock;
    },
  ) {}

  private async customer(id: string): Promise<Customer> {
    const c = await this.d.customers.getById(id);
    if (!c) throw new DomainError("CUSTOMER_NOT_FOUND", `No customer ${id}.`, { customerId: id });
    return c;
  }

  private view(rx: Prescription): PrescriptionView {
    const status = rxStatus(rx, this.d.clock.today());
    return { rx, status, warnings: warningsFor(rx), eligible: status === "valid", reason: reasonFor(rx, status) };
  }

  /** Newest first. Prescriptions that belong to someone else on the same phone are left out. */
  async list(customerId: string): Promise<PrescriptionView[]> {
    const c = await this.customer(customerId);
    let all: Prescription[];
    try {
      all = await this.d.source.listByPhone(c.phone);
    } catch {
      throw new DomainError("RX_UNAVAILABLE", "The store tool is not responding, so prescriptions cannot be shown right now. Try again shortly.");
    }
    return all.filter((r) => r.customerId === c.id).sort(newestFirst).map((r) => this.view(r));
  }

  async get(customerId: string, rxId: string): Promise<PrescriptionView> {
    const found = (await this.list(customerId)).find((v) => v.rx.rxId === rxId);
    if (!found) throw new DomainError("RX_NOT_FOUND", `No prescription ${rxId} for this customer.`, { rxId });
    return found;
  }

  /** What a sale may pick from: every prescription with its status; `eligible` marks the ones a lens can be billed against. */
  eligibleForSale(customerId: string): Promise<PrescriptionView[]> {
    return this.list(customerId);
  }

  async create(customerId: string, input: NewPrescriptionInput, staffId: string, clientRef: string = randomUUID()): Promise<PrescriptionView> {
    const c = await this.customer(customerId);
    const checked = checkNewPrescription(c.id, input, this.d.clock.today());
    if (!checked.ok) {
      throw new DomainError("RX_INVALID", `The prescription needs correcting: ${Object.values(checked.fields).join(" ")}`, { fields: checked.fields });
    }
    let rx: Prescription;
    try {
      rx = await this.d.registry.createPrescription({ ...checked.value, phone: c.phone, clientRef });
    } catch (e) {
      if (e instanceof PrescriptionRejected) throw new DomainError("RX_INVALID", "The store tool did not accept this prescription. Check the values and try again.", { fields: {} });
      throw e; // an unknown outcome surfaces as 502; retrying with the same clientRef cannot duplicate it
    }
    this.d.audit.record({ at: this.d.clock.now().toISOString(), staffId, action: "prescription.created", ref: `customer:${c.id}`, payload: { rxId: rx.rxId, source: rx.source } });
    return this.view(rx);
  }
}
