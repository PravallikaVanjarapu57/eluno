import { describe, expect, it } from "vitest";
import { addPair, mrpTotal, removePair, type NewPair } from "../../src/domain/cart.js";
import { validateLensForRx } from "../../src/domain/lens.js";
import { cart, eye, frame, lens, rx, TODAY } from "../support/fixtures.js";

const NOW = "2026-10-23T11:00:00.000Z";
const pair = (p: Partial<NewPair>): NewPair => ({ frame: null, lens: null, frameStock: null, lensIssues: [], today: TODAY, ...p });
const lensLine = (l = lens("progressive", 1.6), r = rx({ od: eye(-3.25, 0, 2.5), os: eye(-3.25, 0, 2.5) })) => ({ item: l, rx: r });

describe("addPair", () => {
  it("frame + lens become pair 1 with prices snapshotted", () => {
    const c = addPair(cart(), pair({ frame: frame(), frameStock: 2, lens: lensLine() }), NOW);
    expect(c.pairs).toHaveLength(1);
    expect(c.pairs[0]).toMatchObject({ pairRef: "1", frame: { sku: "FR-0003" }, lens: { rx: { rxId: "RX1" } } });
    expect(mrpTotal(c)).toBe(1099800 + 499900);
    expect(c.updatedAt).toBe(NOW);
  });

  it("frame only and lens only are both pairs; refs keep increasing after a removal", () => {
    let c = addPair(cart(), pair({ frame: frame(), frameStock: 5 }), NOW);
    c = addPair(c, pair({ lens: lensLine() }), NOW);
    c = removePair(c, "1", NOW);
    c = addPair(c, pair({ frame: frame(), frameStock: 5 }), NOW);
    expect(c.pairs.map((p) => p.pairRef)).toEqual(["2", "3"]);
  });

  it("needs something", () => {
    expect(() => addPair(cart(), pair({}), NOW)).toThrow(expect.objectContaining({ code: "PAIR_EMPTY" }));
  });

  it("out of stock at the billing store", () => {
    expect(() => addPair(cart(), pair({ frame: frame(), frameStock: 0 }), NOW)).toThrow(expect.objectContaining({ code: "OUT_OF_STOCK" }));
  });

  it("counts units already in the cart against stock", () => {
    const c = addPair(cart(), pair({ frame: frame(), frameStock: 1 }), NOW);
    expect(() => addPair(c, pair({ frame: frame(), frameStock: 1 }), NOW)).toThrow(/1 in stock at HSR, 1 already in this cart/);
  });

  it("archived frames are not billable", () => {
    expect(() => addPair(cart(), pair({ frame: frame({ sellable: false }), frameStock: 3 }), NOW)).toThrow(expect.objectContaining({ code: "ITEM_NOT_SELLABLE" }));
  });

  it("non-Rx sunglasses cannot take a lens, but sell frame-only", () => {
    const sun = frame({ category: "sunglasses", rxAble: false, hsn: "90049000" });
    expect(() => addPair(cart(), pair({ frame: sun, frameStock: 3, lens: lensLine() }), NOW)).toThrow(expect.objectContaining({ code: "FRAME_NOT_RX_ABLE" }));
    expect(addPair(cart(), pair({ frame: sun, frameStock: 3 }), NOW).pairs).toHaveLength(1);
  });

  it("blocks an expired prescription", () => {
    const old = rx({ testedOn: "2025-07-16", validUntil: "2026-07-16" });
    expect(() => addPair(cart(), pair({ lens: lensLine(lens("single_vision", 1.5), old) }), NOW)).toThrow(
      expect.objectContaining({ code: "RX_NOT_IN_FORCE", message: expect.stringMatching(/expired on 2026-07-16/) }),
    );
  });

  it("blocks another customer's prescription", () => {
    expect(() => addPair(cart(), pair({ lens: lensLine(lens("single_vision", 1.5), rx({ customerId: "C2" })) }), NOW)).toThrow(
      expect.objectContaining({ code: "RX_NOT_FOUND" }),
    );
  });

  it("blocks a lens that does not fit the Rx, with the reason and the alternative", () => {
    const l = lens("single_vision", 1.56);
    const r = rx({ od: eye(-6), os: eye(-6) });
    const err = (() => {
      try {
        addPair(cart(), pair({ lens: { item: l, rx: r }, lensIssues: validateLensForRx(l, r), lensAlternatives: "Choose index 1.60, 1.67, 1.74 for single vision." }), NOW);
      } catch (e) {
        return e as { code: string; message: string; details: { issues: unknown[]; suggestion: string } };
      }
    })();
    expect(err?.code).toBe("LENS_RX_MISMATCH");
    expect(err?.message).toMatch(/^Right eye \(OD\) SPH -6.00 .* Choose index 1.60, 1.67, 1.74 for single vision\.$/);
    expect(err?.details.issues).toHaveLength(2);
  });

  it("a billed cart is closed", () => {
    expect(() => addPair(cart({ status: "checked_out" }), pair({ frame: frame(), frameStock: 1 }), NOW)).toThrow(expect.objectContaining({ code: "CART_CLOSED" }));
  });
});

describe("removePair", () => {
  it("unknown pair", () => {
    expect(() => removePair(cart(), "9", NOW)).toThrow(expect.objectContaining({ code: "PAIR_NOT_FOUND" }));
  });
});
