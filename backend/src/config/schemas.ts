import { z } from "zod";

// POS-owned data files. Changing a rate or an offer is a data change, never a code change,
// so these schemas are strict: an unknown condition key fails at startup instead of being silently ignored.

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const bps = z.number().int().min(0).max(10000);
const paise = z.number().int().nonnegative();

// ---------------------------------------------------------------- tax rates

export const TaxRateSchema = z.strictObject({
  hsn: z.string().regex(/^\d{4,8}$/),
  description: z.string(),
  rate_bps: bps,
  effective_from: isoDate,
  effective_to: isoDate.optional(),
});

export const TaxRatesFileSchema = z
  .object({ about: z.string().optional(), rates: z.array(TaxRateSchema).min(1) })
  .superRefine((file, ctx) => {
    const byHsn = new Map<string, z.infer<typeof TaxRateSchema>[]>();
    for (const r of file.rates) {
      if (r.effective_to && r.effective_to < r.effective_from) {
        ctx.addIssue({ code: "custom", message: `HSN ${r.hsn}: effective_to before effective_from` });
      }
      byHsn.set(r.hsn, [...(byHsn.get(r.hsn) ?? []), r]);
    }
    // Two rates for the same HSN must not both be in force on any day.
    for (const [hsn, rates] of byHsn) {
      const sorted = [...rates].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
      for (let i = 1; i < sorted.length; i++) {
        const prev = sorted[i - 1]!;
        const cur = sorted[i]!;
        if (!prev.effective_to || prev.effective_to >= cur.effective_from) {
          ctx.addIssue({ code: "custom", message: `HSN ${hsn}: overlapping rates from ${prev.effective_from} and ${cur.effective_from}` });
        }
      }
    }
  });

// ---------------------------------------------------------------- offers

const OfferConditionSchema = z.strictObject({
  min_pairs_in_cart: z.number().int().positive().optional(),
  customer_tag: z.string().min(1).optional(),
  lens_type: z.enum(["single_vision", "bifocal", "progressive"]).optional(),
  index_min: z.number().positive().optional(),
  coating: z.string().min(1).optional(),
  has_frame_and_lens: z.boolean().optional(),
});

const OfferRequiresSchema = z.strictObject({
  role: z.enum(["sales", "optometrist", "store_manager"]).optional(),
  reason_code: z.boolean().optional(),
});

const PercentDiscountSchema = z
  .strictObject({
    type: z.literal("percent"),
    value_bps: bps.optional(),
    // Manager-entered percent: the till supplies the value, capped here.
    value_bps_max: bps.optional(),
    on: z.enum(["lowest_priced_lens_line"]).optional(),
  })
  .refine((d) => (d.value_bps === undefined) !== (d.value_bps_max === undefined), {
    message: "percent discount needs exactly one of value_bps or value_bps_max",
  });

const FlatDiscountSchema = z.strictObject({
  type: z.literal("flat"),
  value_paise: paise.positive(),
});

export const OfferSchema = z
  .strictObject({
    offer_id: z.string().regex(/^[A-Z0-9_]+$/),
    name: z.string(),
    active: z.boolean(),
    valid_from: isoDate,
    valid_to: isoDate,
    stackable: z.boolean(),
    priority: z.number().int(),
    rule: z.strictObject({
      applies_to: z.enum(["frame", "lens", "pair", "cart"]),
      condition: OfferConditionSchema.optional(),
      requires: OfferRequiresSchema.optional(),
      discount: z.union([PercentDiscountSchema, FlatDiscountSchema]),
      max_discount_paise: paise.optional(),
    }),
  })
  .refine((o) => o.valid_from <= o.valid_to, { message: "valid_from after valid_to" });

export const OffersFileSchema = z.array(OfferSchema).superRefine((offers, ctx) => {
  const seen = new Set<string>();
  for (const o of offers) {
    if (seen.has(o.offer_id)) ctx.addIssue({ code: "custom", message: `duplicate offer_id ${o.offer_id}` });
    seen.add(o.offer_id);
  }
});

const ReasonCodeSchema = z.strictObject({ code: z.string().regex(/^[A-Z0-9_]+$/), label: z.string().min(1) });
export const ReasonCodesFileSchema = z.object({
  about: z.string().optional(),
  discount: z.array(ReasonCodeSchema).min(1),
  refund: z.array(ReasonCodeSchema).min(1),
});

export type TaxRateRecord = z.infer<typeof TaxRateSchema>;
export type OfferRecord = z.infer<typeof OfferSchema>;
