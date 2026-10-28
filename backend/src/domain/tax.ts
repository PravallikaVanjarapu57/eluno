import { DomainError } from "./errors.js";
import { assertPaise, divHalfUp, type Paise } from "./money.js";

// GST on MRP-inclusive prices, intra-state (CGST + SGST). Rates are data with effective dates: the rate is the
// one in force on the invoice date, so a rate change never alters an invoice already issued.

export interface TaxRate {
  hsn: string;
  rateBps: number;
  effectiveFrom: string; // YYYY-MM-DD inclusive
  effectiveTo: string | null; // inclusive; null = open-ended
}

export interface LineTax {
  hsn: string;
  rateBps: number;
  /** Amount the customer pays for the line (after discount), GST inclusive. */
  grossPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
}

export class TaxTable {
  constructor(private readonly rates: readonly TaxRate[]) {}

  rateFor(hsn: string, onDate: string): TaxRate {
    const rate = this.rates.find((r) => r.hsn === hsn && r.effectiveFrom <= onDate && (r.effectiveTo === null || onDate <= r.effectiveTo));
    if (!rate) {
      throw new DomainError("TAX_RATE_MISSING", `No GST rate for HSN ${hsn} on ${onDate}. Finance must add it to tax_rates.json before this item can be billed.`, { hsn, onDate });
    }
    return rate;
  }
}

/**
 * Back GST out of an inclusive amount, per line:
 *   taxable = round_half_up(gross × 10000 / (10000 + rate_bps));  tax = gross − taxable
 *   CGST = round_half_up(tax / 2);  SGST = tax − CGST
 * so taxable + CGST + SGST == gross exactly.
 */
export function backOutGst(grossPaise: Paise, rateBps: number): Omit<LineTax, "hsn" | "rateBps" | "grossPaise"> {
  assertPaise(grossPaise, "gross");
  if (grossPaise < 0) throw new DomainError("TAX_RATE_MISSING", "Cannot tax a negative amount.", { grossPaise });
  const taxablePaise = divHalfUp(grossPaise * 10_000, 10_000 + rateBps);
  const tax = grossPaise - taxablePaise;
  const cgstPaise = divHalfUp(tax, 2);
  return { taxablePaise, cgstPaise, sgstPaise: tax - cgstPaise };
}

export function taxLine(table: TaxTable, hsn: string, grossPaise: Paise, onDate: string): LineTax {
  const { rateBps } = table.rateFor(hsn, onDate);
  return { hsn, rateBps, grossPaise, ...backOutGst(grossPaise, rateBps) };
}
