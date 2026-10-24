import type { LensConfig } from "../catalog.js";
import { allocate, formatInr, percentOf, type Paise } from "../money.js";
import type { ManualDiscount, Offer } from "./offer.js";

// Offer evaluation.
//
// Semantics (documented in the README; change here, not ad hoc at the till):
//  1. An offer is eligible when it is active, today is within its dates (inclusive), its conditions hold,
//     and it has something to discount.
//  2. Non-stackable means "not combined with any other offer". The candidates are each eligible
//     non-stackable offer on its own, and all eligible stackable offers together. (Adding a stackable offer
//     never lowers the total, so no subset of the stackables can beat the full set.)
//  3. Within a candidate, offers apply in priority order (lower first), each on what is left after the
//     earlier ones. No line ever goes below zero.
//  4. The customer gets the candidate with the largest total discount. Ties: lowest priority number,
//     then fewer offers, then offer id, so the result is deterministic.
//  5. Scope: frame/lens offers apply per matching line; pair offers once per matching pair; cart offers once.
//     Flat amounts over several lines are split in proportion to those lines' remaining value, to the paisa.
//  6. max_discount_paise caps an offer's total across the bill.

export interface OfferLine {
  lineId: string;
  pairRef: string;
  kind: "frame" | "lens";
  grossPaise: Paise;
  lens: LensConfig | null;
}

export interface OfferContext {
  today: string;
  customerTags: readonly string[];
  manual: ManualDiscount | null;
}

export interface LineAllocation {
  lineId: string;
  amountPaise: Paise;
}

export interface AppliedOffer {
  offerId: string;
  name: string;
  amountPaise: Paise;
  allocations: LineAllocation[];
}

export interface OfferEvaluation {
  offerId: string;
  name: string;
  applied: boolean;
  amountPaise: Paise;
  why: string;
}

export interface OfferResult {
  applied: AppliedOffer[];
  evaluations: OfferEvaluation[];
  totalDiscountPaise: Paise;
  /** lineId -> total discount on that line, for every line (0 when none). */
  lineDiscounts: Record<string, Paise>;
}

type Eligibility = { ok: true; groups: OfferLine[][]; bps?: number } | { ok: false; why: string };

const lensMatches = (o: Offer, l: OfferLine): boolean => {
  if (!l.lens) return false;
  const c = o.condition;
  return (!c.lensType || l.lens.type === c.lensType) && (c.indexMin === undefined || l.lens.index >= c.indexMin) && (!c.coating || l.lens.coating === c.coating);
};
const hasLensCondition = (o: Offer) => o.condition.lensType !== undefined || o.condition.indexMin !== undefined || o.condition.coating !== undefined;

function describeLensCondition(o: Offer): string {
  const c = o.condition;
  return [c.lensType?.replace("_", " "), c.indexMin !== undefined && `index ${c.indexMin.toFixed(2)}+`, c.coating?.replace("_", " ")].filter(Boolean).join(" ") + " lens";
}

function pairsOf(lines: readonly OfferLine[]): Map<string, OfferLine[]> {
  const pairs = new Map<string, OfferLine[]>();
  for (const l of lines) pairs.set(l.pairRef, [...(pairs.get(l.pairRef) ?? []), l]);
  return pairs;
}
const isFullPair = (p: OfferLine[]) => p.some((l) => l.kind === "frame") && p.some((l) => l.kind === "lens");

export function eligibility(offer: Offer, lines: readonly OfferLine[], ctx: OfferContext): Eligibility {
  if (!offer.active) return { ok: false, why: "Offer is switched off." };
  if (ctx.today < offer.validFrom) return { ok: false, why: `Starts on ${offer.validFrom}.` };
  if (ctx.today > offer.validTo) return { ok: false, why: `Ended on ${offer.validTo}.` };

  let bps: number | undefined;
  if (offer.discount.type === "percent_manual" || offer.requires.role || offer.requires.reasonCode) {
    const m = ctx.manual;
    if (!m || m.offerId !== offer.id) return { ok: false, why: "Needs a store manager's approval with a reason code." };
    if (offer.requires.role && (m.approverRole !== offer.requires.role || !m.approverCanOverride)) {
      return { ok: false, why: `Approver ${m.approverId} is not a ${offer.requires.role.replace("_", " ")} who can override discounts.` };
    }
    if (offer.requires.reasonCode && !m.reasonCode) return { ok: false, why: "A reason code is required." };
    if (offer.discount.type === "percent_manual") {
      if (m.bps <= 0 || m.bps > offer.discount.bpsMax) return { ok: false, why: `Manager discount must be between 0.01% and ${offer.discount.bpsMax / 100}%.` };
      bps = m.bps;
    }
  }

  const c = offer.condition;
  if (c.customerTag && !ctx.customerTags.includes(c.customerTag)) return { ok: false, why: `Customer is not tagged "${c.customerTag}".` };

  const pairs = pairsOf(lines);
  if (c.minPairsInCart !== undefined) {
    // A "pair" for this purpose is eyewear with a lens: a frame-only sunglasses sale is not a second pair.
    const withLens = [...pairs.values()].filter((p) => p.some((l) => l.kind === "lens")).length;
    if (withLens < c.minPairsInCart) return { ok: false, why: `Needs ${c.minPairsInCart} pairs with lenses; this bill has ${withLens}.` };
  }

  let groups: OfferLine[][];
  switch (offer.appliesTo) {
    case "frame":
      groups = lines.filter((l) => l.kind === "frame").map((l) => [l]);
      if (groups.length === 0) return { ok: false, why: "No frame on this bill." };
      break;
    case "lens": {
      let lenses = lines.filter((l) => l.kind === "lens" && lensMatches(offer, l));
      if (lenses.length === 0) return { ok: false, why: hasLensCondition(offer) ? `No ${describeLensCondition(offer)} on this bill.` : "No lens on this bill." };
      if (offer.discount.type === "percent" && offer.discount.on === "lowest_priced_lens_line") {
        // The cheaper lens is "the second pair"; on a tie, the later pair.
        const lowest = [...lenses].sort((a, b) => a.grossPaise - b.grossPaise || Number(b.pairRef) - Number(a.pairRef))[0]!;
        lenses = [lowest];
      }
      groups = lenses.map((l) => [l]);
      break;
    }
    case "pair":
      groups = [...pairs.values()].filter((p) => !c.hasFrameAndLens || isFullPair(p));
      if (groups.length === 0) return { ok: false, why: c.hasFrameAndLens ? "No pair with both a frame and a lens." : "Nothing to discount." };
      break;
    case "cart":
      groups = lines.length > 0 ? [[...lines]] : [];
      if (groups.length === 0) return { ok: false, why: "Nothing to discount." };
      break;
  }
  if (offer.appliesTo !== "lens" && hasLensCondition(offer) && !lines.some((l) => lensMatches(offer, l))) {
    return { ok: false, why: `Needs a ${describeLensCondition(offer)} on the bill.` };
  }
  if (c.hasFrameAndLens && offer.appliesTo !== "pair" && ![...pairs.values()].some(isFullPair)) {
    return { ok: false, why: "Needs a pair with both a frame and a lens." };
  }
  return { ok: true, groups, ...(bps !== undefined && { bps }) };
}

/** Apply one offer on top of `remaining` (mutated). Returns the per-line amounts. */
function applyOffer(offer: Offer, e: Extract<Eligibility, { ok: true }>, remaining: Map<string, Paise>): LineAllocation[] {
  const amounts = new Map<string, Paise>();
  const add = (lineId: string, amt: Paise) => amounts.set(lineId, (amounts.get(lineId) ?? 0) + amt);

  for (const group of e.groups) {
    const left = group.map((l) => remaining.get(l.lineId)!);
    const d = offer.discount;
    if (d.type === "flat") {
      const amt = Math.min(d.paise, left.reduce((a, b) => a + b, 0));
      if (amt > 0) allocate(amt, left).forEach((a, i) => add(group[i]!.lineId, a));
    } else {
      const bps = d.type === "percent" ? d.bps : e.bps!;
      group.forEach((l, i) => add(l.lineId, percentOf(left[i]!, bps)));
    }
  }

  const lineIds = [...amounts.keys()];
  let values = lineIds.map((id) => amounts.get(id)!);
  const total = values.reduce((a, b) => a + b, 0);
  if (offer.maxDiscountPaise !== undefined && total > offer.maxDiscountPaise) {
    values = allocate(offer.maxDiscountPaise, values);
  }
  const out: LineAllocation[] = [];
  lineIds.forEach((id, i) => {
    const amt = Math.min(values[i]!, remaining.get(id)!);
    if (amt > 0) {
      remaining.set(id, remaining.get(id)! - amt);
      out.push({ lineId: id, amountPaise: amt });
    }
  });
  return out;
}

interface Candidate {
  offers: Offer[];
  applied: AppliedOffer[];
  total: Paise;
}

function runCandidate(offers: Offer[], elig: Map<string, Extract<Eligibility, { ok: true }>>, lines: readonly OfferLine[]): Candidate {
  const remaining = new Map(lines.map((l) => [l.lineId, l.grossPaise]));
  const ordered = [...offers].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const applied = ordered.map((o) => {
    const allocations = applyOffer(o, elig.get(o.id)!, remaining);
    return { offerId: o.id, name: o.name, amountPaise: allocations.reduce((a, x) => a + x.amountPaise, 0), allocations };
  });
  return { offers: ordered, applied, total: applied.reduce((a, x) => a + x.amountPaise, 0) };
}

function better(a: Candidate, b: Candidate): boolean {
  if (a.total !== b.total) return a.total > b.total;
  const minPrio = (c: Candidate) => Math.min(...c.offers.map((o) => o.priority));
  if (minPrio(a) !== minPrio(b)) return minPrio(a) < minPrio(b);
  if (a.offers.length !== b.offers.length) return a.offers.length < b.offers.length;
  return a.offers.map((o) => o.id).join() < b.offers.map((o) => o.id).join();
}

export function evaluateOffers(lines: readonly OfferLine[], offers: readonly Offer[], ctx: OfferContext): OfferResult {
  const elig = new Map<string, Extract<Eligibility, { ok: true }>>();
  const notEligible = new Map<string, string>();
  for (const o of offers) {
    const e = eligibility(o, lines, ctx);
    if (e.ok) elig.set(o.id, e);
    else notEligible.set(o.id, e.why);
  }

  const eligible = offers.filter((o) => elig.has(o.id));
  const candidates: Candidate[] = eligible.filter((o) => !o.stackable).map((o) => runCandidate([o], elig, lines));
  const stackables = eligible.filter((o) => o.stackable);
  if (stackables.length > 0) candidates.push(runCandidate(stackables, elig, lines));

  let best: Candidate | null = null;
  for (const c of candidates) if (c.total > 0 && (!best || better(c, best))) best = c;

  const applied = best ? best.applied.filter((a) => a.amountPaise > 0) : [];
  const label = (c: Candidate) => c.offers.map((o) => o.id).join(" + ");
  const evaluations: OfferEvaluation[] = offers.map((o) => {
    const reason = notEligible.get(o.id);
    if (reason) return { offerId: o.id, name: o.name, applied: false, amountPaise: 0, why: reason };
    const mine = applied.find((a) => a.offerId === o.id);
    if (mine) return { offerId: o.id, name: o.name, applied: true, amountPaise: mine.amountPaise, why: `Applied: ${formatInr(mine.amountPaise)} off.` };
    if (best?.offers.includes(o)) return { offerId: o.id, name: o.name, applied: false, amountPaise: 0, why: "Eligible, but earlier offers left nothing for it to discount." };
    const own = candidates.find((c) => c.offers.includes(o))!;
    const ownAmount = own.applied.find((a) => a.offerId === o.id)?.amountPaise ?? 0;
    const why = !best
      ? "Eligible, but gives no discount on this bill."
      : o.stackable
        ? `Stackable offers together give ${formatInr(own.total)}; ${label(best)} gives more (${formatInr(best.total)}) and does not combine.`
        : `Does not combine with other offers. On its own it gives ${formatInr(ownAmount)}; ${label(best)} gives ${formatInr(best.total)}.`;
    return { offerId: o.id, name: o.name, applied: false, amountPaise: 0, why };
  });

  const lineDiscounts: Record<string, Paise> = Object.fromEntries(lines.map((l) => [l.lineId, 0]));
  for (const a of applied) for (const x of a.allocations) lineDiscounts[x.lineId]! += x.amountPaise;

  return { applied, evaluations, totalDiscountPaise: applied.reduce((a, x) => a + x.amountPaise, 0), lineDiscounts };
}
