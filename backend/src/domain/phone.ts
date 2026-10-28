import { DomainError } from "./errors.js";

/** Normalise what staff type ("90000 00005", "+91-9000000005", "09000000005") to E.164 "+919000000005". */
export function normalizeIndianMobile(input: string): string {
  const digits = input.replace(/[\s\-()]/g, "");
  const m = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  if (!m) {
    throw new DomainError("INVALID_PHONE", `"${input}" is not a 10-digit Indian mobile number`, { input });
  }
  return `+91${m[1]}`;
}
