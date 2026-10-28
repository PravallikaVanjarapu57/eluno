import { describe, expect, it } from "vitest";
import { money, ratePct, todayIST } from "./format";

describe("format", () => {
  it("formats paise with Indian grouping and exact paise", () => {
    expect(money(1869700)).toBe("₹18,697.00");
    expect(money(10499800)).toBe("₹1,04,998.00");
    expect(money(29)).toBe("₹0.29");
    expect(money(0)).toBe("₹0.00");
    expect(money(-18697)).toBe("−₹186.97");
  });
  it("formats a GST rate in basis points", () => {
    expect(ratePct(1800)).toBe("18%");
    expect(ratePct(250)).toBe("2.5%");
  });
  it("uses the IST calendar day, not UTC", () => {
    expect(todayIST(new Date("2026-10-23T20:00:00Z"))).toBe("2026-10-24");
  });
});
