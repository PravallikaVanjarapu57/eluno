import { describe, expect, it } from "vitest";
import { allocate, divHalfUp, formatInr, MoneyError, percentOf, sum } from "../../src/domain/money.js";
import { fromShopifyMoney, toShopifyMoney } from "../../src/adapters/shopify/money.js";

describe("divHalfUp", () => {
  it.each([
    [10, 4, 3], // 2.5 -> 3
    [9, 4, 2], // 2.25 -> 2
    [11, 4, 3], // 2.75 -> 3
    [-10, 4, -3], // half away from zero
    [0, 7, 0],
    [1907215, 1, 1907215],
  ])("%i / %i = %i", (n, d, q) => expect(divHalfUp(n, d)).toBe(q));

  it("backs out GST like the reference (₹10,998 frame at 18% -> taxable 9,320.34)", () => {
    expect(divHalfUp(1099800 * 10000, 10000 + 1800)).toBe(932034);
  });

  it("rejects non-integers and zero divisors", () => {
    expect(() => divHalfUp(1.5, 2)).toThrow(MoneyError);
    expect(() => divHalfUp(1, 0)).toThrow(/division by zero/);
  });
});

describe("percentOf", () => {
  it("15% of ₹9,499 = ₹1,424.85 (the PGX campaign line in order #1001)", () => {
    expect(percentOf(949900, 1500)).toBe(142485);
  });
  it("rounds half-up to the paisa", () => {
    expect(percentOf(5, 5000)).toBe(3); // 2.5 -> 3
    expect(percentOf(333, 1000)).toBe(33); // 33.3 -> 33
  });
});

describe("allocate", () => {
  it("always sums to the total", () => {
    for (const [total, weights] of [
      [50000, [1099800, 949900]],
      [100, [1, 1, 1]],
      [1, [5, 5]],
      [30000, [799900, 0, 249900]],
    ] as [number, number[]][]) {
      expect(sum(allocate(total, weights))).toBe(total);
    }
  });

  it("splits proportionally and gives leftover paise to the largest remainder", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [1, 2])).toEqual([3, 7]); // 3.33 / 6.67 -> 7 has the larger remainder
  });

  it("gives nothing to zero-weight lines", () => {
    expect(allocate(1000, [0, 3, 1])).toEqual([0, 750, 250]);
  });

  it("rejects impossible splits", () => {
    expect(allocate(0, [0, 0])).toEqual([0, 0]);
    expect(() => allocate(5, [0, 0])).toThrow(MoneyError);
    expect(() => allocate(-5, [1])).toThrow(MoneyError);
  });
});

describe("Shopify money boundary", () => {
  it.each([
    [1907215, "19072.15"],
    [5, "0.05"],
    [0, "0.00"],
    [-142485, "-1424.85"],
  ])("%i paise <-> %s", (paise, str) => {
    expect(toShopifyMoney(paise)).toBe(str);
    expect(fromShopifyMoney(str)).toBe(paise);
  });

  it("parses without float error", () => {
    expect(fromShopifyMoney("0.29")).toBe(29); // 0.29 * 100 = 28.999999999999996 in floats
    expect(fromShopifyMoney("-0.00")).toBe(0);
  });

  it.each([["1.5"], ["1e3"], ["12"], [""], [" 1.00"]])("rejects %j", (s) => {
    expect(() => fromShopifyMoney(s)).toThrow(MoneyError);
  });

  it("rejects numbers (Shopify money is never a JSON number)", () => {
    expect(() => fromShopifyMoney(104.98)).toThrow(/decimal string/);
  });

  it("refuses to serialise a non-integer", () => {
    expect(() => toShopifyMoney(10.5)).toThrow(MoneyError);
  });
});

describe("formatInr", () => {
  it("uses Indian digit grouping", () => {
    expect(formatInr(1907215)).toBe("₹19,072.15");
    expect(formatInr(12345678900)).toBe("₹12,34,56,789.00");
    expect(formatInr(-500)).toBe("-₹5.00");
  });
});
