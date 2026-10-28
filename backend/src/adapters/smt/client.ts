import { z } from "zod";
import type { Prescription } from "../../domain/prescription.js";
import type { Staff } from "../../domain/store.js";
import { PrescriptionOutcomeUnknown, PrescriptionRejected, type PrescriptionIndex, type PrescriptionRegistry, type PrescriptionSource, type StaffDirectory, type StaffRoster } from "../../ports/index.js";
import { AmbiguousWriteError, HttpError, parseUpstream, RetriesExhaustedError, type HttpClient } from "../http/client.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const quarterDioptre = z.number().refine((v) => Number.isInteger(v * 4), "not on the 0.25 D grid");

const EyeSchema = z.object({
  sph: quarterDioptre,
  cyl: quarterDioptre,
  axis: z.number().int().min(0).max(180).nullable(),
  add: quarterDioptre.nullable(),
});

const SmtPrescriptionSchema = z.object({
  rx_id: z.string(),
  customer_id: z.number().int(),
  phone: z.string(),
  date: isoDate,
  source: z.enum(["in_store", "external"]),
  optometrist_id: z.string().nullable(),
  od: EyeSchema,
  os: EyeSchema,
  pd: z.object({ binocular: z.number().nullable(), mono_r: z.number().nullable(), mono_l: z.number().nullable() }),
  valid_until: isoDate,
  notes: z.string().nullable(),
});

const ListSchema = z.object({ prescriptions: z.array(SmtPrescriptionSchema) });

const OneSchema = z.object({ prescription: SmtPrescriptionSchema });

const toPrescription = (r: z.infer<typeof SmtPrescriptionSchema>): Prescription => ({
  rxId: r.rx_id,
  customerId: String(r.customer_id),
  testedOn: r.date,
  validUntil: r.valid_until,
  source: r.source,
  optometristId: r.optometrist_id,
  od: r.od,
  os: r.os,
  pd: { binocular: r.pd.binocular, monoR: r.pd.mono_r, monoL: r.pd.mono_l },
  notes: r.notes,
});

/** Store-management tool adapter: prescriptions live here, not in Shopify. */
export class SmtClient implements PrescriptionSource, PrescriptionIndex, PrescriptionRegistry {
  constructor(private readonly http: HttpClient) {}

  async listByPhone(phone: string): Promise<Prescription[]> {
    const res = await this.http.get("smt/prescriptions", { phone });
    return parseUpstream("smt", "prescription list", ListSchema, res.body).prescriptions.map(toPrescription);
  }

  async listByPhones(phones: readonly string[]): Promise<Prescription[]> {
    if (phones.length === 0) return [];
    const res = await this.http.get("smt/prescriptions", { phones: phones.join(",") });
    return parseUpstream("smt", "prescription list", ListSchema, res.body).prescriptions.map(toPrescription);
  }

  async createPrescription(input: Parameters<PrescriptionRegistry["createPrescription"]>[0]): Promise<Prescription> {
    try {
      const res = await this.http.post(
        "smt/prescriptions",
        {
          client_ref: input.clientRef,
          customer_id: Number(input.customerId),
          phone: input.phone,
          date: input.testedOn,
          valid_until: input.validUntil,
          source: input.source,
          optometrist_id: input.optometristId,
          od: input.od,
          os: input.os,
          pd: { binocular: input.pd.binocular, mono_r: input.pd.monoR, mono_l: input.pd.monoL },
          notes: input.notes,
        },
        { idempotent: true }, // the client_ref makes a repeat return the stored record, so an uncertain write can be sent again
      );
      return toPrescription(parseUpstream("smt", "prescription", OneSchema, res.body).prescription);
    } catch (e) {
      if (e instanceof AmbiguousWriteError || e instanceof RetriesExhaustedError) throw new PrescriptionOutcomeUnknown(e.message);
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) throw new PrescriptionRejected(`The store tool refused the prescription: ${JSON.stringify(e.body)}`);
      throw e;
    }
  }
}

const StaffListSchema = z.object({
  staff: z.array(
    z.object({
      staff_id: z.string(),
      name: z.string(),
      role: z.enum(["sales", "optometrist", "store_manager"]),
      store_code: z.string(),
      badges: z.array(z.string()),
      can_override_discount: z.boolean(),
    }),
  ),
});

export class SmtStaffDirectory implements StaffDirectory, StaffRoster {
  constructor(private readonly http: HttpClient) {}

  listByStore(storeCode: string): Promise<Staff[]> {
    return this.fetch({ store: storeCode });
  }

  listAll(): Promise<Staff[]> {
    return this.fetch({});
  }

  private async fetch(query: Record<string, string>): Promise<Staff[]> {
    const res = await this.http.get("smt/staff", query);
    return parseUpstream("smt", "staff list", StaffListSchema, res.body).staff.map((s) => ({
      staffId: s.staff_id,
      name: s.name,
      role: s.role,
      storeCode: s.store_code,
      badges: s.badges,
      canOverrideDiscount: s.can_override_discount,
    }));
  }
}
