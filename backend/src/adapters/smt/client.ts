import { z } from "zod";
import type { Prescription } from "../../domain/prescription.js";
import type { Staff } from "../../domain/store.js";
import type { PrescriptionSource, StaffDirectory } from "../../ports/index.js";
import { parseUpstream, type HttpClient } from "../http/client.js";

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

/** Store-management tool adapter: prescriptions live here, not in Shopify. */
export class SmtClient implements PrescriptionSource {
  constructor(private readonly http: HttpClient) {}

  async listByPhone(phone: string): Promise<Prescription[]> {
    const res = await this.http.get("smt/prescriptions", { phone });
    return parseUpstream("smt", "prescription list", ListSchema, res.body).prescriptions.map((r) => ({
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
    }));
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

export class SmtStaffDirectory implements StaffDirectory {
  constructor(private readonly http: HttpClient) {}

  async listByStore(storeCode: string): Promise<Staff[]> {
    const res = await this.http.get("smt/staff", { store: storeCode });
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
