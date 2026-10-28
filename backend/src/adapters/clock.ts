import type { Clock } from "../ports/index.js";

/** Store dates are IST. `fixedToday` (env TILL_TODAY) pins the business date for demos and tests. */
export function systemClock(fixedToday?: string): Clock {
  return {
    now: () => new Date(),
    today: () => fixedToday ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()),
  };
}
