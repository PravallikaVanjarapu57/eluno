import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Offer, ReasonCode } from "../domain/offers/offer.js";
import type { TaxRate } from "../domain/tax.js";
import { OffersFileSchema, ReasonCodesFileSchema, TaxRatesFileSchema, type OfferRecord } from "./schemas.js";

export class ConfigError extends Error {}

function loadJson<T>(file: string, schema: z.ZodType<T>): T {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(`${file}: cannot read JSON (${(e as Error).message})`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`${file}: invalid\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export interface PosConfig {
  taxRates: TaxRate[];
  offers: Offer[];
  reasonCodes: { discount: ReasonCode[]; refund: ReasonCode[] };
}

export function toOffer(r: OfferRecord): Offer {
  const c = r.rule.condition ?? {};
  const d = r.rule.discount;
  return {
    id: r.offer_id,
    name: r.name,
    active: r.active,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    stackable: r.stackable,
    priority: r.priority,
    appliesTo: r.rule.applies_to,
    condition: {
      ...(c.min_pairs_in_cart !== undefined && { minPairsInCart: c.min_pairs_in_cart }),
      ...(c.customer_tag !== undefined && { customerTag: c.customer_tag }),
      ...(c.lens_type !== undefined && { lensType: c.lens_type }),
      ...(c.index_min !== undefined && { indexMin: c.index_min }),
      ...(c.coating !== undefined && { coating: c.coating }),
      ...(c.has_frame_and_lens !== undefined && { hasFrameAndLens: c.has_frame_and_lens }),
    },
    requires: {
      ...(r.rule.requires?.role !== undefined && { role: r.rule.requires.role }),
      ...(r.rule.requires?.reason_code !== undefined && { reasonCode: r.rule.requires.reason_code }),
    },
    discount:
      d.type === "flat"
        ? { type: "flat", paise: d.value_paise }
        : d.value_bps_max !== undefined
          ? { type: "percent_manual", bpsMax: d.value_bps_max }
          : { type: "percent", bps: d.value_bps!, ...(d.on && { on: d.on }) },
    ...(r.rule.max_discount_paise !== undefined && { maxDiscountPaise: r.rule.max_discount_paise }),
  };
}

export function loadPosConfig(configDir: string): PosConfig {
  return {
    taxRates: loadJson(path.join(configDir, "tax_rates.json"), TaxRatesFileSchema).rates.map((r) => ({
      hsn: r.hsn,
      rateBps: r.rate_bps,
      effectiveFrom: r.effective_from,
      effectiveTo: r.effective_to ?? null,
    })),
    offers: loadJson(path.join(configDir, "offers.json"), OffersFileSchema).map(toOffer),
    reasonCodes: loadJson(path.join(configDir, "reason_codes.json"), ReasonCodesFileSchema),
  };
}
