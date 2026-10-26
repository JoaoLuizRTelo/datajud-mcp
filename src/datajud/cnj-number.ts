/**
 * CNJ unified case number ("numeração única"), defined by CNJ Resolution 65/2008:
 *
 *   NNNNNNN-DD.AAAA.J.TR.OOOO
 *   │       │  │    │ │  └ origin unit
 *   │       │  │    │ └ court within the segment
 *   │       │  │    └ judicial segment (4 = federal, 8 = state, ...)
 *   │       │  └ filing year
 *   │       └ check digits (ISO 7064 mod 97-10)
 *   └ sequential number
 */

export interface CnjNumber {
  /** 20 digits, no punctuation: the format DataJud stores in `numeroProcesso`. */
  digits: string;
  /** Human-readable `NNNNNNN-DD.AAAA.J.TR.OOOO`. */
  formatted: string;
  sequential: string;
  checkDigits: string;
  year: number;
  segment: number;
  court: string;
  origin: string;
}

export class InvalidCnjNumberError extends Error {
  override readonly name = "InvalidCnjNumberError";
}

export function computeCheckDigits(digitsWithoutCheck: string): string {
  // N(7) + A(4) + J(1) + TR(2) + O(4) + "00", mod 97, then 98 - remainder.
  const remainder = Number(BigInt(`${digitsWithoutCheck}00`) % 97n);
  return String(98 - remainder).padStart(2, "0");
}

export function parseCnjNumber(input: string): CnjNumber {
  const digits = input.replace(/[\s.-]/g, "");
  if (!/^\d{20}$/.test(digits)) {
    throw new InvalidCnjNumberError(
      `Invalid CNJ number "${input}": expected 20 digits in the format NNNNNNN-DD.AAAA.J.TR.OOOO.`,
    );
  }

  const sequential = digits.slice(0, 7);
  const checkDigits = digits.slice(7, 9);
  const year = digits.slice(9, 13);
  const segment = digits.slice(13, 14);
  const court = digits.slice(14, 16);
  const origin = digits.slice(16, 20);

  const expected = computeCheckDigits(sequential + year + segment + court + origin);
  if (expected !== checkDigits) {
    throw new InvalidCnjNumberError(
      `Invalid CNJ number "${input}": check digits are ${checkDigits} but should be ${expected}. ` +
        "The number was probably mistyped.",
    );
  }

  return {
    digits,
    formatted: `${sequential}-${checkDigits}.${year}.${segment}.${court}.${origin}`,
    sequential,
    checkDigits,
    year: Number(year),
    segment: Number(segment),
    court,
    origin,
  };
}

/** Formats 20 raw digits for display without validating them (DataJud data is trusted as-is). */
export function formatCnjDigits(digits: string): string {
  if (!/^\d{20}$/.test(digits)) return digits;
  return `${digits.slice(0, 7)}-${digits.slice(7, 9)}.${digits.slice(9, 13)}.${digits.slice(13, 14)}.${digits.slice(14, 16)}.${digits.slice(16)}`;
}
