import { DomainError } from "../errors.js";
import type { Staff } from "../store.js";
import type { ManualDiscount, Offer, ReasonCode } from "./offer.js";

// Finance: no manual discount without a reason code and the approver's identity.
// Retail: no approval chain. Both hold if the store manager is the approver and the reason is one tap.

export function buildManualDiscount(input: {
  offer: Offer | undefined;
  approver: Staff | undefined;
  approverId: string;
  storeCode: string;
  reasonCode: string;
  reasonCodes: readonly ReasonCode[];
  bps: number;
  requestedBy: string;
}): ManualDiscount {
  const { offer, approver } = input;
  const fail = (message: string, details: Record<string, unknown> = {}) => {
    throw new DomainError("MANUAL_DISCOUNT_INVALID", message, details);
  };
  if (!offer || offer.discount.type !== "percent_manual") return fail("Manager discounts are not configured.");
  if (!offer.active) return fail("Manager discounts are switched off.");
  if (!approver || approver.storeCode !== input.storeCode) return fail(`${input.approverId} is not on the ${input.storeCode} roster.`, { approverId: input.approverId });
  if ((offer.requires.role && approver.role !== offer.requires.role) || !approver.canOverrideDiscount) {
    return fail(`${approver.name} (${approver.role.replace("_", " ")}) cannot approve discounts; ask the store manager.`, { approverId: approver.staffId });
  }
  if (!input.reasonCodes.some((r) => r.code === input.reasonCode)) {
    return fail(`Unknown reason code "${input.reasonCode}". Pick one of: ${input.reasonCodes.map((r) => r.code).join(", ")}.`, { reasonCode: input.reasonCode });
  }
  if (!Number.isInteger(input.bps) || input.bps <= 0 || input.bps > offer.discount.bpsMax) {
    return fail(`Manager discount must be between 0.01% and ${offer.discount.bpsMax / 100}% (got ${input.bps / 100}%).`, { bps: input.bps, bpsMax: offer.discount.bpsMax });
  }
  return {
    offerId: offer.id,
    bps: input.bps,
    approverId: approver.staffId,
    approverRole: approver.role,
    approverCanOverride: approver.canOverrideDiscount,
    reasonCode: input.reasonCode,
    requestedBy: input.requestedBy,
  };
}
