import type { Paise } from "../api/types";

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Integer paise -> "₹1,04,998.00". Never goes through a float for the rupee part. */
export function money(paise: Paise): string {
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const text = inr.format(Math.trunc(abs / 100) + (abs % 100) / 100);
  return (neg ? "−" : "") + text;
}

export const ratePct = (bps: number) => `${bps / 100}%`;

export const dioptre = (v: number | null) => (v === null ? "—" : (v > 0 ? "+" : "") + v.toFixed(2));

/** Today's calendar date in India, YYYY-MM-DD (the till's business date is IST). */
export function todayIST(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now);
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" });
}

export const label = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
