import { assertPaise, MoneyError, type Paise } from "../../domain/money.js";

// Shopify speaks money as decimal strings ("104.98"); the domain speaks integer paise.
// Parsing is done on the string itself, never through a float.

const MONEY = /^(-)?(\d+)\.(\d{2})$/;

export function toShopifyMoney(amount: Paise): string {
  assertPaise(amount);
  const abs = Math.abs(amount);
  return `${amount < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function fromShopifyMoney(value: unknown): Paise {
  if (typeof value !== "string") throw new MoneyError(`expected a decimal string, got ${typeof value}`);
  const m = MONEY.exec(value);
  if (!m) throw new MoneyError(`not a 2-decimal money string: "${value}"`);
  const paise = Number(m[2]) * 100 + Number(m[3]);
  return assertPaise(m[1] && paise !== 0 ? -paise : paise);
}
