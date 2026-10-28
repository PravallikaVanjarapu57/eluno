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

/** 2026-10-28 -> "28 Oct 2026": month spelled out, so day and month cannot be swapped by a reader. */
export function dateIN(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-IN", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
}

/** The default expiry the server applies: 365 days after the test date, exactly as backend/src/domain/prescription.ts computes it. */
export function addYear(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCDate(d.getUTCDate() + 365);
  return d.toISOString().slice(0, 10);
}
