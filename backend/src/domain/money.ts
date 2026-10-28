// Money inside the till is always an integer number of paise. Decimal strings exist only at the
// Shopify boundary (adapters/shopify/money.ts). Amounts stay far below 2^53, so plain numbers are exact.

export type Paise = number;

export class MoneyError extends Error { }

export function assertPaise(value: number, what = "amount"): Paise {
  if (!Number.isSafeInteger(value)) throw new MoneyError(`${what} must be an integer number of paise, got ${value}`);
  return value;
}

export function sum(values: readonly Paise[]): Paise {
  return values.reduce((acc, v) => acc + assertPaise(v), 0);
}

/** Integer division rounded half away from zero (half-up for positive amounts). */
export function divHalfUp(numerator: number, denominator: number): Paise {
  assertPaise(numerator, "numerator");
  assertPaise(denominator, "denominator");
  if (denominator === 0) throw new MoneyError("division by zero");
  const sign = Math.sign(numerator) * Math.sign(denominator);
  const n = Math.abs(numerator);
  const d = Math.abs(denominator);
  const q = Math.floor(n / d);
  const r = n - q * d;
  return sign * (2 * r >= d ? q + 1 : q);
}

/** amount × bps / 10000, rounded half-up to the paisa. */
export function percentOf(amount: Paise, bps: number): Paise {
  return divHalfUp(assertPaise(amount) * assertPaise(bps, "bps"), 10_000);
}

/**
 * Split `total` across `weights` in proportion, so the parts always sum to `total` exactly
 * (largest-remainder method). Leftover paise go to the largest remainders; ties go to the earlier index.
 */
export function allocate(total: Paise, weights: readonly number[]): Paise[] {
  assertPaise(total, "total");
  if (total < 0) throw new MoneyError("cannot allocate a negative total");
  weights.forEach((w) => {
    assertPaise(w, "weight");
    if (w < 0) throw new MoneyError("weights must be non-negative");
  });
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) {
    if (total === 0) return weights.map(() => 0);
    throw new MoneyError("cannot allocate a non-zero total over zero weights");
  }

  const parts = weights.map((w) => Math.floor((total * w) / weightSum));
  const remainders = weights.map((w, i) => ({ i, r: total * w - parts[i]! * weightSum }));
  let left = total - parts.reduce((a, b) => a + b, 0);
  remainders.sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of remainders) {
    if (left === 0) break;
    parts[i]! += 1;
    left -= 1;
  }
  return parts;
}

/** For humans and logs only, e.g. 1907215 → "₹19,072.15". Never sent to Shopify. */
export function formatInr(amount: Paise): string {
  assertPaise(amount);
  const abs = Math.abs(amount);
  const rupees = Math.floor(abs / 100).toLocaleString("en-IN");
  return `${amount < 0 ? "-" : ""}₹${rupees}.${String(abs % 100).padStart(2, "0")}`;
}
