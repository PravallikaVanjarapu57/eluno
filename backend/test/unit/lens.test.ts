import { describe, expect, it } from "vitest";
import { formatDioptre, lensOptionsFor, suggestAlternatives, validateLensForRx } from "../../src/domain/lens.js";
import { eye, lens, matrix, rx } from "../support/fixtures.js";

describe("validateLensForRx", () => {
  it("Dr. Iyer's case: -6.00 on a 1.56 is blocked, with the eye, value and range", () => {
    const issues = validateLensForRx(lens("single_vision", 1.56), rx({ od: eye(-6), os: eye(-5.75) }));
    expect(issues.map((i) => [i.code, i.eye])).toEqual([["SPH_OUT_OF_RANGE", "od"], ["SPH_OUT_OF_RANGE", "os"]]);
    expect(issues[0]!.message).toBe("Right eye (OD) SPH -6.00 is outside the single vision 1.56 standard range (-4.00 to +4.00).");
  });

  it("limits are inclusive", () => {
    expect(validateLensForRx(lens("single_vision", 1.56), rx({ od: eye(-4, -2), os: eye(4, 2) }))).toEqual([]);
    expect(validateLensForRx(lens("single_vision", 1.56), rx({ od: eye(-4.25), os: eye(4) }))).toHaveLength(1);
  });

  it("checks |CYL| for either sign", () => {
    const issues = validateLensForRx(lens("single_vision", 1.5), rx({ od: eye(-1, -2.25), os: eye(-1, 2.5) }));
    expect(issues.map((i) => i.code)).toEqual(["CYL_OUT_OF_RANGE", "CYL_OUT_OF_RANGE"]);
  });

  it("progressive and bifocal need an ADD in both eyes", () => {
    for (const t of ["progressive", "bifocal"] as const) {
      const issues = validateLensForRx(lens(t, 1.6), rx({ od: eye(-2), os: eye(-2, 0, 2) }));
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ code: "ADD_MISSING", eye: "od" });
      expect(issues[0]!.message).toMatch(/choose single vision/);
    }
  });

  it("ADD outside the lens's range", () => {
    expect(validateLensForRx(lens("progressive", 1.6), rx({ od: eye(-2, 0, 3.25), os: eye(-2, 0, 0.5) })).map((i) => i.code)).toEqual(["ADD_OUT_OF_RANGE", "ADD_OUT_OF_RANGE"]);
  });

  it("single vision ignores an ADD (distance-only pair for a presbyope is a valid sale)", () => {
    expect(validateLensForRx(lens("single_vision", 1.5), rx({ od: eye(-2, 0, 2), os: eye(-2, 0, 2) }))).toEqual([]);
  });
});

describe("lens options and suggestions", () => {
  const highMinus = rx({ od: eye(-5.25, -0.5), os: eye(-5, -0.5) }); // seed RX5026

  it("marks every lens valid or invalid for the Rx", () => {
    const opts = lensOptionsFor(matrix(), highMinus);
    const sv = opts.filter((o) => o.lens.config.type === "single_vision");
    expect(sv.map((o) => [o.lens.config.index, o.valid])).toEqual([[1.5, false], [1.56, false], [1.6, true], [1.67, true], [1.74, true]]);
    expect(opts.filter((o) => o.lens.config.type !== "single_vision").every((o) => !o.valid)).toBe(true); // no ADD
  });

  it("skips archived lenses", () => {
    expect(lensOptionsFor([lens("single_vision", 1.6, "standard", { sellable: false })], highMinus)).toEqual([]);
  });

  it("suggests higher indexes of the same type", () => {
    expect(suggestAlternatives(matrix(), highMinus, lens("single_vision", 1.56))).toBe("Choose index 1.60, 1.67, 1.74 for single vision.");
  });

  it("suggests another type when none of the wanted type fits", () => {
    expect(suggestAlternatives(matrix(), highMinus, lens("progressive", 1.6))).toBe("No progressive lens fits this prescription; available: single vision.");
  });

  it("refers out when nothing fits", () => {
    expect(suggestAlternatives(matrix(), rx({ od: eye(-16), os: eye(-16) }), lens("single_vision", 1.74))).toMatch(/refer to the optometrist/);
  });
});

describe("formatDioptre", () => {
  it.each([[-6, "-6.00"], [2.5, "+2.50"], [0, "0.00"], [-0.25, "-0.25"]])("%d -> %s", (v, s) => expect(formatDioptre(v)).toBe(s));
});
