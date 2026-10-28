import type { Cart } from "./cart.js";
import { evaluateOffers, type OfferLine, type OfferResult } from "./offers/engine.js";
import type { Offer } from "./offers/offer.js";
import type { Paise } from "./money.js";
import { taxLine, type TaxTable } from "./tax.js";

// The bill's lines, in pair order, frame before lens. Line ids are stable within a cart: "<pairRef>:<kind>".

export interface QuoteLine {
  lineId: string;
  pairRef: string;
  kind: "frame" | "lens";
  sku: string;
  hsn: string;
  grossPaise: Paise; // MRP, GST inclusive
  discountPaise: Paise;
  /** What the customer pays for the line, GST inclusive. */
  netPaise: Paise;
  rateBps: number;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
}

export interface Quote {
  invoiceDate: string;
  lines: QuoteLine[];
  offers: OfferResult;
  grossPaise: Paise;
  discountPaise: Paise;
  taxablePaise: Paise;
  cgstPaise: Paise;
  sgstPaise: Paise;
  taxPaise: Paise;
  /** Amount to charge. */
  netPaise: Paise;
}

export function offerLinesOf(cart: Cart): (OfferLine & { sku: string; hsn: string })[] {
  return cart.pairs.flatMap((p) => [
    ...(p.frame ? [{ lineId: `${p.pairRef}:frame`, pairRef: p.pairRef, kind: "frame" as const, grossPaise: p.frame.pricePaise, lens: null, sku: p.frame.sku, hsn: p.frame.hsn }] : []),
    ...(p.lens ? [{ lineId: `${p.pairRef}:lens`, pairRef: p.pairRef, kind: "lens" as const, grossPaise: p.lens.item.pricePaise, lens: p.lens.item.config, sku: p.lens.item.sku, hsn: p.lens.item.hsn }] : []),
  ]);
}

/**
 * Offers first, on the inclusive price; then GST backed out of what is left, per line.
 * `invoiceDate` decides both which offers are live and which tax rates apply.
 */
export function quoteCart(cart: Cart, offers: readonly Offer[], taxes: TaxTable, invoiceDate: string): Quote {
  const lines = offerLinesOf(cart);
  const result = evaluateOffers(lines, offers, { today: invoiceDate, customerTags: cart.customer.tags, manual: cart.manualDiscount });
  const quoteLines: QuoteLine[] = lines.map((l) => {
    const discountPaise = result.lineDiscounts[l.lineId] ?? 0;
    const netPaise = l.grossPaise - discountPaise;
    const t = taxLine(taxes, l.hsn, netPaise, invoiceDate);
    return {
      lineId: l.lineId, pairRef: l.pairRef, kind: l.kind, sku: l.sku, hsn: l.hsn,
      grossPaise: l.grossPaise, discountPaise, netPaise,
      rateBps: t.rateBps, taxablePaise: t.taxablePaise, cgstPaise: t.cgstPaise, sgstPaise: t.sgstPaise,
    };
  });
  const sum = (f: (l: QuoteLine) => Paise) => quoteLines.reduce((a, l) => a + f(l), 0);
  const cgstPaise = sum((l) => l.cgstPaise);
  const sgstPaise = sum((l) => l.sgstPaise);
  return {
    invoiceDate,
    lines: quoteLines,
    offers: result,
    grossPaise: sum((l) => l.grossPaise),
    discountPaise: sum((l) => l.discountPaise),
    taxablePaise: sum((l) => l.taxablePaise),
    cgstPaise,
    sgstPaise,
    taxPaise: cgstPaise + sgstPaise,
    netPaise: sum((l) => l.netPaise),
  };
}
