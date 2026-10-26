import { describe, expect, it } from "vitest";
import {
  computeCheckDigits,
  formatCnjDigits,
  InvalidCnjNumberError,
  parseCnjNumber,
} from "../../src/datajud/cnj-number.js";

describe("parseCnjNumber", () => {
  it("parses a formatted number", () => {
    const cnj = parseCnjNumber("0000832-35.2018.4.01.3202");
    expect(cnj).toMatchObject({
      digits: "00008323520184013202",
      formatted: "0000832-35.2018.4.01.3202",
      year: 2018,
      segment: 4,
      court: "01",
      origin: "3202",
    });
  });

  it("accepts raw digits and stray whitespace", () => {
    expect(parseCnjNumber(" 00008323520184013202 ").formatted).toBe("0000832-35.2018.4.01.3202");
  });

  it.each(["07134929520238070016", "07535123120238070016"])("validates real number %s", (n) => {
    expect(() => parseCnjNumber(n)).not.toThrow();
  });

  it("rejects wrong check digits and says what they should be", () => {
    expect(() => parseCnjNumber("0000832-36.2018.4.01.3202")).toThrow(/should be 35/);
  });

  it.each(["", "123", "0000832-35.2018.4.01.320X", "000083235201840132021"])(
    "rejects malformed input %j",
    (input) => {
      expect(() => parseCnjNumber(input)).toThrow(InvalidCnjNumberError);
    },
  );
});

describe("computeCheckDigits", () => {
  it("pads single-digit results", () => {
    // Search a number whose check digits are < 10 to cover zero padding.
    for (let n = 0; n < 500; n++) {
      const body = `${String(n).padStart(7, "0")}2020826` + "0100";
      const dd = computeCheckDigits(body);
      expect(dd).toMatch(/^\d{2}$/);
    }
  });
});

describe("formatCnjDigits", () => {
  it("formats 20 digits and leaves anything else untouched", () => {
    expect(formatCnjDigits("00008323520184013202")).toBe("0000832-35.2018.4.01.3202");
    expect(formatCnjDigits("abc")).toBe("abc");
  });
});
