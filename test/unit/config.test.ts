import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigError, loadPosConfig } from "../../src/config/load.js";

const REAL = "config";

function tempConfig(overrides: { offers?: unknown; tax?: unknown }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "till-cfg-"));
  const offers = overrides.offers ?? JSON.parse(readFileSync(path.join(REAL, "offers.json"), "utf8"));
  const tax = overrides.tax ?? JSON.parse(readFileSync(path.join(REAL, "tax_rates.json"), "utf8"));
  writeFileSync(path.join(dir, "offers.json"), JSON.stringify(offers));
  writeFileSync(path.join(dir, "tax_rates.json"), JSON.stringify(tax));
  writeFileSync(path.join(dir, "reason_codes.json"), readFileSync(path.join(REAL, "reason_codes.json"), "utf8"));
  return dir;
}

const offer = (rule: object, extra: object = {}) => ({
  offer_id: "X", name: "x", active: true, valid_from: "2026-01-01", valid_to: "2026-12-31",
  stackable: true, priority: 1, rule, ...extra,
});

describe("loadPosConfig", () => {
  it("loads the shipped offers and tax rates", () => {
    const cfg = loadPosConfig(REAL);
    expect(cfg.offers.map((o) => o.id)).toContain("MANAGER_OVERRIDE");
    expect(cfg.offers).toHaveLength(8);
    expect(cfg.taxRates.filter((r) => r.hsn === "90015000").map((r) => r.rateBps).sort()).toEqual([1200, 500]);
  });

  it("maps offer rules into domain offers", () => {
    const byId = Object.fromEntries(loadPosConfig(REAL).offers.map((o) => [o.id, o]));
    expect(byId.FESTIVE10).toMatchObject({ appliesTo: "frame", stackable: false, discount: { type: "percent", bps: 1000 }, maxDiscountPaise: 200000 });
    expect(byId.SECONDPAIR50!.discount).toEqual({ type: "percent", bps: 5000, on: "lowest_priced_lens_line" });
    expect(byId.MANAGER_OVERRIDE).toMatchObject({ requires: { role: "store_manager", reasonCode: true }, discount: { type: "percent_manual", bpsMax: 1000 } });
    expect(byId.FREE_BLUECUT_PGX!.condition).toEqual({ lensType: "progressive", indexMin: 1.6, coating: "blue_cut" });
  });

  it("rejects an unknown offer condition instead of silently ignoring it", () => {
    const dir = tempConfig({ offers: [offer({ applies_to: "cart", condition: { min_spend: 1 }, discount: { type: "flat", value_paise: 100 } })] });
    expect(() => loadPosConfig(dir)).toThrow(ConfigError);
  });

  it("rejects a percent discount with neither value_bps nor value_bps_max", () => {
    const dir = tempConfig({ offers: [offer({ applies_to: "cart", discount: { type: "percent" } })] });
    expect(() => loadPosConfig(dir)).toThrow(/exactly one of value_bps/);
  });

  it("rejects money as a decimal (paise must be integers)", () => {
    const dir = tempConfig({ offers: [offer({ applies_to: "cart", discount: { type: "flat", value_paise: 499.5 } })] });
    expect(() => loadPosConfig(dir)).toThrow(ConfigError);
  });

  it("rejects duplicate offer ids", () => {
    const o = offer({ applies_to: "cart", discount: { type: "flat", value_paise: 100 } });
    expect(() => loadPosConfig(tempConfig({ offers: [o, o] }))).toThrow(/duplicate offer_id X/);
  });

  it("rejects overlapping tax rates for the same HSN", () => {
    const tax = { rates: [
      { hsn: "90031900", description: "a", rate_bps: 1800, effective_from: "2025-01-01" },
      { hsn: "90031900", description: "b", rate_bps: 1200, effective_from: "2026-01-01" },
    ] };
    expect(() => loadPosConfig(tempConfig({ tax }))).toThrow(/overlapping rates/);
  });
});
