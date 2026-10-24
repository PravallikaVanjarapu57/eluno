import { describe, expect, it } from "vitest";
import { loadPosConfig } from "../../src/config/load.js";
import { quoteCart } from "../../src/domain/pricing.js";
import { TaxTable } from "../../src/domain/tax.js";
import { cart, customer, eye, frame, lens, rx } from "../support/fixtures.js";

const cfg = loadPosConfig("config");
const taxes = new TaxTable(cfg.taxRates);

describe("quoteCart: offers then GST per line", () => {
  const c = cart({
    customer: customer({ id: "80001005", tags: ["campaign:progressive_oct26", "priority"] }),
    pairs: [{
      pairRef: "1",
      frame: frame(),
      lens: { item: lens("progressive", 1.6, "blue_cut", { pricePaise: 949900, sku: "LN-0043" }), rx: rx({ customerId: "80001005", od: eye(-3.25, 0, 2.5), os: eye(-3.25, 0, 2.5) }) },
    }],
  });

  it("Karthik's bill: ₹1,800 off, GST backed out of what is left, per line", () => {
    const q = quoteCart(c, cfg.offers, taxes, "2026-10-23");
    expect(q.lines.map(({ lineId, hsn, netPaise, rateBps, taxablePaise, cgstPaise, sgstPaise }) => ({ lineId, hsn, netPaise, rateBps, taxablePaise, cgstPaise, sgstPaise }))).toEqual([
      { lineId: "1:frame", hsn: "90031900", netPaise: 1054673, rateBps: 1800, taxablePaise: 893791, cgstPaise: 80441, sgstPaise: 80441 },
      { lineId: "1:lens", hsn: "90015000", netPaise: 815027, rateBps: 500, taxablePaise: 776216, cgstPaise: 19406, sgstPaise: 19405 },
    ]);
    expect(q).toMatchObject({ grossPaise: 2049700, discountPaise: 180000, taxablePaise: 1670007, cgstPaise: 99847, sgstPaise: 99846, taxPaise: 199693, netPaise: 1869700 });
    expect(q.taxablePaise + q.taxPaise).toBe(q.netPaise);
  });

  it("the invoice date picks both the offers and the rates", () => {
    const q = quoteCart(c, cfg.offers, taxes, "2025-09-21");
    expect(q.lines.find((l) => l.kind === "lens")!.rateBps).toBe(1200);
    expect(q.discountPaise).toBe(0); // no offer in offers.json had started yet
  });
});
