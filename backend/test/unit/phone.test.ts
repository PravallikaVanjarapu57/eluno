import { describe, expect, it } from "vitest";
import { normalizeIndianMobile } from "../../src/domain/phone.js";
import { DomainError } from "../../src/domain/errors.js";

describe("normalizeIndianMobile", () => {
  it.each(["9000000005", "+919000000005", "+91 90000 00005", "91-9000000005", "09000000005", "(+91) 90000-00005"])("%s", (input) => {
    expect(normalizeIndianMobile(input)).toBe("+919000000005");
  });

  it.each(["12345", "5000000005", "+1 4155550123", "abc"])("rejects %s", (input) => {
    expect(() => normalizeIndianMobile(input)).toThrow(DomainError);
  });
});
