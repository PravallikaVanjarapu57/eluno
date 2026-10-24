import { describe, expect, it } from "vitest";
import { loadPosConfig } from "../../src/config/load.js";
import { evaluateOffers, type OfferContext, type OfferLine } from "../../src/domain/offers/engine.js";
import type { ManualDiscount, Offer } from "../../src/domain/offers/offer.js";
import type { LensType } from "../../src/domain/catalog.js";

const OFFERS = loadPosConfig("config").offers;
const ctx = (over: Partial<OfferContext> = {}): OfferContext => ({ today: "2026-10-23", customerTags: [], manual: null, ...over });
const frame = (pairRef: string, gross: number): OfferLine => ({ lineId: `${pairRef}:frame`, pairRef, kind: "frame", grossPaise: gross, lens: null });
const lens = (pairRef: string, gross: number, type: LensType = "single_vision", index = 1.56, coating = "standard"): OfferLine => ({
  lineId: `${pairRef}:lens`, pairRef, kind: "lens", grossPaise: gross, lens: { type, index, coating },
});
const ids = (r: ReturnType<typeof evaluateOffers>) => r.applied.map((a) => a.offerId);
const why = (r: ReturnType<typeof evaluateOffers>, id: string) => r.evaluations.find((e) => e.offerId === id)!.why;

describe("offer engine: seed bills", () => {
  // #1001: priority + progressive-campaign customer, FR-0003 ₹10,998 + progressive 1.60 blue cut ₹9,499.
  const bill1001 = [frame("1", 1099800), lens("1", 949900, "progressive", 1.6, "blue_cut")];
  const karthik = ["campaign:progressive_oct26", "priority"];

  it("#1001: the stackable combination (₹1,800) beats PGX_CAMPAIGN15 alone (₹1,424.85), which the old till applied", () => {
    const r = evaluateOffers(bill1001, OFFERS, ctx({ customerTags: karthik }));
    expect(ids(r)).toEqual(["FREE_BLUECUT_PGX", "PRIORITY500", "BUNDLE300"]);
    expect(r.totalDiscountPaise).toBe(180000);
    expect(r.applied.map((a) => a.allocations)).toEqual([
      [{ lineId: "1:lens", amountPaise: 100000 }],
      [{ lineId: "1:frame", amountPaise: 28204 }, { lineId: "1:lens", amountPaise: 21796 }],
      [{ lineId: "1:frame", amountPaise: 16923 }, { lineId: "1:lens", amountPaise: 13077 }],
    ]);
    expect(r.lineDiscounts).toEqual({ "1:frame": 45127, "1:lens": 134873 });
    expect(why(r, "PGX_CAMPAIGN15")).toBe("Does not combine with other offers. On its own it gives ₹1,424.85; FREE_BLUECUT_PGX + PRIORITY500 + BUNDLE300 gives ₹1,800.00.");
    expect(why(r, "FESTIVE10")).toMatch(/On its own it gives ₹1,099.80/);
    expect(why(r, "SECONDPAIR50")).toBe("Needs 2 pairs with lenses; this bill has 1.");
    expect(why(r, "MANAGER_OVERRIDE")).toMatch(/store manager's approval/);
    expect(why(r, "MONSOON20")).toBe("Offer is switched off.");
  });

  it("#1001 after the campaign ends: PGX_CAMPAIGN15 says so", () => {
    expect(why(evaluateOffers(bill1001, OFFERS, ctx({ today: "2026-11-05", customerTags: karthik })), "PGX_CAMPAIGN15")).toBe("Ended on 2026-10-31.");
  });

  it("#1003: two pairs -> 50% on the cheaper lens plus ₹300 per pair", () => {
    const r = evaluateOffers([frame("1", 699800), lens("1", 199900, "single_vision", 1.56, "anti_reflective"), frame("2", 349800), lens("2", 99900, "single_vision", 1.5)], OFFERS, ctx({ customerTags: ["family"] }));
    expect(ids(r)).toEqual(["SECONDPAIR50", "BUNDLE300"]);
    expect(r.applied[0]!.allocations).toEqual([{ lineId: "2:lens", amountPaise: 49950 }]);
    expect(r.applied[1]!.amountPaise).toBe(60000);
    expect(r.totalDiscountPaise).toBe(109950);
    expect(why(r, "FESTIVE10")).toMatch(/On its own it gives ₹1,049.60/);
  });

  it("#1010: priority customer gets ₹500 + ₹300, not just the bundle", () => {
    const r = evaluateOffers([frame("1", 299800), lens("1", 249900, "single_vision", 1.6)], OFFERS, ctx({ customerTags: ["priority"] }));
    expect(ids(r)).toEqual(["PRIORITY500", "BUNDLE300"]);
    expect(r.totalDiscountPaise).toBe(80000);
  });

  it("#1007: FESTIVE10 (₹1,349.80) beats the ₹300 bundle", () => {
    const r = evaluateOffers([frame("1", 1349800), lens("1", 499900, "single_vision", 1.6, "photochromic")], OFFERS, ctx({ customerTags: ["campaign:festive_frames"] }));
    expect(ids(r)).toEqual(["FESTIVE10"]);
    expect(r.lineDiscounts).toEqual({ "1:frame": 134980, "1:lens": 0 });
    expect(why(r, "BUNDLE300")).toMatch(/Stackable offers together give ₹300.00; FESTIVE10 gives more/);
  });
});

describe("offer engine: rules", () => {
  it("FESTIVE10 is capped at ₹2,000 across the bill, split across frames", () => {
    expect(evaluateOffers([frame("1", 2500000)], OFFERS, ctx()).totalDiscountPaise).toBe(200000);
    const two = evaluateOffers([frame("1", 1500000), frame("2", 1500000)], OFFERS, ctx());
    expect(two.lineDiscounts).toEqual({ "1:frame": 100000, "2:frame": 100000 });
  });

  it("a frame-only sunglasses sale does not count as a second pair", () => {
    const r = evaluateOffers([frame("1", 899800), frame("2", 499800), lens("2", 99900)], OFFERS, ctx());
    expect(why(r, "SECONDPAIR50")).toBe("Needs 2 pairs with lenses; this bill has 1.");
  });

  it("the second-pair discount goes to the cheaper lens; on a tie, the later pair", () => {
    const r = evaluateOffers([lens("1", 99900), lens("2", 99900)], OFFERS, ctx());
    expect(r.applied.find((a) => a.offerId === "SECONDPAIR50")!.allocations).toEqual([{ lineId: "2:lens", amountPaise: 49950 }]);
  });

  it("lens conditions: FREE_BLUECUT_PGX needs progressive, index 1.60+, blue cut", () => {
    expect(why(evaluateOffers([lens("1", 699900, "progressive", 1.56, "blue_cut")], OFFERS, ctx()), "FREE_BLUECUT_PGX")).toBe("No progressive index 1.60+ blue cut lens on this bill.");
    expect(why(evaluateOffers([lens("1", 1299900, "progressive", 1.67, "blue_cut")], OFFERS, ctx()), "FREE_BLUECUT_PGX")).toMatch(/^Applied/);
  });

  it("lens-only and frame-only bills do not get the bundle", () => {
    expect(why(evaluateOffers([lens("1", 199900)], OFFERS, ctx()), "BUNDLE300")).toBe("No pair with both a frame and a lens.");
  });

  it("no offers -> zero discount, every offer explained", () => {
    const r = evaluateOffers([lens("1", 199900)], OFFERS, ctx({ today: "2027-02-01" }));
    expect(r.totalDiscountPaise).toBe(0);
    expect(r.evaluations).toHaveLength(OFFERS.length);
    expect(r.evaluations.every((e) => !e.applied && e.why.length > 0)).toBe(true);
  });

  it("dates are inclusive on both ends", () => {
    expect(why(evaluateOffers([frame("1", 100000)], OFFERS, ctx({ today: "2026-10-01" })), "FESTIVE10")).toMatch(/^Applied/);
    expect(why(evaluateOffers([frame("1", 100000)], OFFERS, ctx({ today: "2026-11-15" })), "FESTIVE10")).toMatch(/^Applied/);
    expect(why(evaluateOffers([frame("1", 100000)], OFFERS, ctx({ today: "2026-09-30" })), "FESTIVE10")).toBe("Starts on 2026-10-01.");
  });
});

describe("offer engine: manager discount", () => {
  const manual = (over: Partial<ManualDiscount> = {}): ManualDiscount => ({
    offerId: "MANAGER_OVERRIDE", bps: 1000, approverId: "S108", approverRole: "store_manager", approverCanOverride: true, reasonCode: "WALKOUT_SAVE", requestedBy: "S105", ...over,
  });
  const bill = [frame("1", 499800), lens("1", 149900)]; // #1012 shape

  it("applies when better for the customer (10% = ₹649.70 vs FESTIVE10 ₹499.80)", () => {
    const r = evaluateOffers(bill, OFFERS, ctx({ manual: manual() }));
    expect(ids(r)).toEqual(["MANAGER_OVERRIDE"]);
    expect(r.totalDiscountPaise).toBe(64970);
  });

  it("is not stacked, so a smaller manager discount loses to a better offer, with the reason", () => {
    const r = evaluateOffers(bill, OFFERS, ctx({ manual: manual({ bps: 500 }) }));
    expect(ids(r)).toEqual(["FESTIVE10"]);
    expect(why(r, "MANAGER_OVERRIDE")).toMatch(/On its own it gives ₹324.85; FESTIVE10 gives ₹499.80/);
  });

  it("is refused for a non-manager or above the cap", () => {
    expect(why(evaluateOffers(bill, OFFERS, ctx({ manual: manual({ approverRole: "sales", approverCanOverride: false }) })), "MANAGER_OVERRIDE")).toMatch(/not a store manager/);
    expect(why(evaluateOffers(bill, OFFERS, ctx({ manual: manual({ bps: 1500 }) })), "MANAGER_OVERRIDE")).toMatch(/between 0.01% and 10%/);
  });
});

describe("offer engine: invariants", () => {
  const offer = (id: string, over: Partial<Offer>): Offer => ({
    id, name: id, active: true, validFrom: "2026-01-01", validTo: "2026-12-31", stackable: true, priority: 50,
    appliesTo: "cart", condition: {}, requires: {}, discount: { type: "flat", paise: 1000 }, ...over,
  });

  it("a flat discount never takes a line below zero", () => {
    const r = evaluateOffers([lens("1", 50000)], [offer("BIG", { appliesTo: "lens", discount: { type: "flat", paise: 100000 } })], ctx());
    expect(r.lineDiscounts["1:lens"]).toBe(50000);
  });

  it("stacked offers never exceed the bill", () => {
    const r = evaluateOffers([frame("1", 100000)], [offer("A", { discount: { type: "percent", bps: 9000 } }), offer("B", { priority: 60, discount: { type: "flat", paise: 50000 } })], ctx());
    expect(r.totalDiscountPaise).toBe(100000);
    expect(why(r, "B")).toMatch(/^Applied: ₹100.00/);
  });

  it("ties go to the lower priority number, deterministically", () => {
    const offers = [offer("LATE", { stackable: false, priority: 20 }), offer("EARLY", { stackable: false, priority: 10 })];
    expect(ids(evaluateOffers([frame("1", 100000)], offers, ctx()))).toEqual(["EARLY"]);
    expect(ids(evaluateOffers([frame("1", 100000)], [...offers].reverse(), ctx()))).toEqual(["EARLY"]);
  });

  it("percent offers apply on what earlier offers left", () => {
    const r = evaluateOffers([frame("1", 100000)], [offer("FLAT", { priority: 1, discount: { type: "flat", paise: 20000 } }), offer("PCT", { priority: 2, discount: { type: "percent", bps: 1000 } })], ctx());
    expect(r.applied.map((a) => a.amountPaise)).toEqual([20000, 8000]);
  });

  it("the sum of line discounts always equals the total", () => {
    const lines = [frame("1", 1099800), lens("1", 949900, "progressive", 1.6, "blue_cut"), frame("2", 349800), lens("2", 99900, "single_vision", 1.5)];
    const r = evaluateOffers(lines, OFFERS, ctx({ customerTags: ["priority", "campaign:progressive_oct26"] }));
    expect(Object.values(r.lineDiscounts).reduce((a, b) => a + b, 0)).toBe(r.totalDiscountPaise);
    for (const l of lines) expect(r.lineDiscounts[l.lineId]!).toBeLessThanOrEqual(l.grossPaise);
  });
});
