import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPosConfig } from "../../src/config/load.js";
import { backOutGst, taxLine, TaxTable } from "../../src/domain/tax.js";
import { fromShopifyMoney } from "../../src/adapters/shopify/money.js";

const table = new TaxTable(loadPosConfig("config").taxRates);

interface SampleLine {
  sku: string;
  price: string;
  quantity: number;
  total_discount: string;
  tax_lines: { title: string; rate: number; price: string }[];
  properties: { name: string; value: string }[];
}
interface SampleOrder {
  name: string;
  created_at: string;
  total_tax: string;
  total_price: string;
  line_items: SampleLine[];
}
const orders = JSON.parse(readFileSync("starter-kit/data/orders_sample.json", "utf8")) as SampleOrder[];
const prop = (li: SampleLine, n: string) => li.properties.find((p) => p.name === n)?.value;

describe("GST golden fixtures: every line of orders_sample.json, to the paisa", () => {
  const cases = orders.flatMap((o) => o.line_items.map((li) => ({ o, li, label: `${o.name} ${li.sku}` })));
  it.each(cases)("$label", ({ o, li }) => {
    const gross = fromShopifyMoney(li.price) * li.quantity - fromShopifyMoney(li.total_discount);
    // Our own rate table, looked up by HSN on the invoice date, must reproduce what was invoiced.
    const t = taxLine(table, prop(li, "hsn")!, gross, o.created_at.slice(0, 10));
    const cgst = li.tax_lines.find((x) => x.title === "CGST")!;
    const sgst = li.tax_lines.find((x) => x.title === "SGST")!;
    expect(t.rateBps).toBe(Math.round(cgst.rate * 20000));
    expect([t.cgstPaise, t.sgstPaise]).toEqual([fromShopifyMoney(cgst.price), fromShopifyMoney(sgst.price)]);
    expect(t.taxablePaise + t.cgstPaise + t.sgstPaise).toBe(gross);
  });

  it.each(orders)("$name order totals", (o) => {
    const lines = o.line_items.map((li) => taxLine(table, prop(li, "hsn")!, fromShopifyMoney(li.price) * li.quantity - fromShopifyMoney(li.total_discount), o.created_at.slice(0, 10)));
    expect(lines.reduce((a, l) => a + l.cgstPaise + l.sgstPaise, 0)).toBe(fromShopifyMoney(o.total_tax));
    expect(lines.reduce((a, l) => a + l.grossPaise, 0)).toBe(fromShopifyMoney(o.total_price));
  });

  it("matches the sample invoice for #1001 line 2 (lens after ₹1,424.85 off)", () => {
    expect(taxLine(table, "90015000", 807415, "2026-10-02")).toEqual({ hsn: "90015000", rateBps: 500, grossPaise: 807415, taxablePaise: 768967, cgstPaise: 19224, sgstPaise: 19224 });
  });
});

describe("backOutGst", () => {
  it("odd tax paisa goes to CGST (half-up), SGST takes the remainder", () => {
    expect(backOutGst(105, 500)).toEqual({ taxablePaise: 100, cgstPaise: 3, sgstPaise: 2 });
  });

  it("tiny and zero amounts (a zero-charge remake)", () => {
    expect(backOutGst(1, 1800)).toEqual({ taxablePaise: 1, cgstPaise: 0, sgstPaise: 0 });
    expect(backOutGst(0, 500)).toEqual({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 });
  });

  it("always reconciles, and CGST and SGST differ by at most a paisa", () => {
    for (const rate of [500, 1200, 1800, 2800]) {
      for (let gross = 0; gross < 200_000; gross += 997) {
        const t = backOutGst(gross, rate);
        expect(t.taxablePaise + t.cgstPaise + t.sgstPaise).toBe(gross);
        expect(t.cgstPaise - t.sgstPaise === 0 || t.cgstPaise - t.sgstPaise === 1).toBe(true);
      }
    }
  });
});

describe("TaxTable", () => {
  it("picks the rate in force on the invoice date (lens 12% -> 5% on 2025-09-22)", () => {
    expect(table.rateFor("90015000", "2025-09-21").rateBps).toBe(1200);
    expect(table.rateFor("90015000", "2025-09-22").rateBps).toBe(500);
    expect(table.rateFor("90031900", "2026-10-23").rateBps).toBe(1800);
    expect(table.rateFor("90049000", "2026-10-23").rateBps).toBe(1800);
  });

  it("blocks billing when no rate exists, with who must fix it", () => {
    expect(() => table.rateFor("12345678", "2026-10-23")).toThrow(expect.objectContaining({ code: "TAX_RATE_MISSING", message: expect.stringMatching(/Finance must add it/) }));
    expect(() => table.rateFor("90049000", "2025-01-01")).toThrow(expect.objectContaining({ code: "TAX_RATE_MISSING" }));
  });
});
