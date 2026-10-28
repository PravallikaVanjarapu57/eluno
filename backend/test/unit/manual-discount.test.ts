import { describe, expect, it } from "vitest";
import { loadPosConfig } from "../../src/config/load.js";
import { buildManualDiscount } from "../../src/domain/offers/manual.js";
import type { Staff } from "../../src/domain/store.js";

const cfg = loadPosConfig("config");
const manager: Staff = { staffId: "S108", name: "Meera", role: "store_manager", storeCode: "HSR", badges: [], canOverrideDiscount: true };
const sales: Staff = { staffId: "S105", name: "Arjun", role: "sales", storeCode: "HSR", badges: [], canOverrideDiscount: false };
const input = (over: Partial<Parameters<typeof buildManualDiscount>[0]> = {}) => ({
  offer: cfg.offers.find((o) => o.id === "MANAGER_OVERRIDE"), approver: manager, approverId: "S108", storeCode: "HSR",
  reasonCode: "WALKOUT_SAVE", reasonCodes: cfg.reasonCodes.discount, bps: 750, requestedBy: "S105", ...over,
});

describe("buildManualDiscount", () => {
  it("records who approved, why, and how much", () => {
    expect(buildManualDiscount(input())).toEqual({
      offerId: "MANAGER_OVERRIDE", bps: 750, approverId: "S108", approverRole: "store_manager", approverCanOverride: true, reasonCode: "WALKOUT_SAVE", requestedBy: "S105",
    });
  });

  it.each([
    ["a sales associate as approver", { approver: sales, approverId: "S105" }, /cannot approve discounts; ask the store manager/],
    ["a manager from another store", { approver: { ...manager, storeCode: "MM" } }, /not on the HSR roster/],
    ["an unknown approver", { approver: undefined, approverId: "S999" }, /S999 is not on the HSR roster/],
    ["an unknown reason code", { reasonCode: "BECAUSE" }, /Unknown reason code "BECAUSE". Pick one of: WALKOUT_SAVE/],
    ["more than 10%", { bps: 1001 }, /between 0.01% and 10% \(got 10.01%\)/],
    ["zero", { bps: 0 }, /between/],
  ])("refuses %s", (_label, over, msg) => {
    expect(() => buildManualDiscount(input(over))).toThrow(expect.objectContaining({ code: "MANUAL_DISCOUNT_INVALID", message: expect.stringMatching(msg) }));
  });
});
