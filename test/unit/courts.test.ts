import { describe, expect, it } from "vitest";
import { computeCheckDigits, parseCnjNumber } from "../../src/datajud/cnj-number.js";
import {
  COURTS,
  findCourt,
  indexName,
  resolveCourtFromCnj,
  UnsupportedCourtError,
} from "../../src/datajud/courts.js";

/** Builds a valid CNJ number for a given segment (J) and court (TR). */
function cnjFor(segment: number, tr: number): string {
  const body = `0000001` + `2024` + String(segment) + String(tr).padStart(2, "0") + `0001`;
  const dd = computeCheckDigits(body);
  return body.slice(0, 7) + dd + body.slice(7);
}

describe("COURTS", () => {
  it("lists the 91 indices published on the DataJud wiki", () => {
    expect(COURTS).toHaveLength(91);
    expect(new Set(COURTS.map((c) => c.alias)).size).toBe(91);
  });

  it("uses DataJud's spelling for the Federal District", () => {
    expect(findCourt("tjdft")).toBeDefined();
    expect(findCourt("tre-dft")).toBeDefined();
    expect(findCourt("tjdf")).toBeUndefined();
  });

  it("builds index names", () => {
    expect(indexName("TRF1")).toBe("api_publica_trf1");
    expect(indexName("tre-sp")).toBe("api_publica_tre-sp");
  });
});

describe("resolveCourtFromCnj", () => {
  it.each([
    [3, 0, "stj"],
    [4, 1, "trf1"],
    [4, 6, "trf6"],
    [5, 0, "tst"],
    [5, 15, "trt15"],
    [6, 0, "tse"],
    [6, 26, "tre-sp"],
    [6, 7, "tre-dft"],
    [7, 0, "stm"],
    [8, 26, "tjsp"],
    [8, 7, "tjdft"],
    [8, 13, "tjmg"],
    [9, 13, "tjmmg"],
    [9, 21, "tjmrs"],
    [9, 26, "tjmsp"],
  ])("segment %i court %i → %s", (segment, tr, alias) => {
    expect(resolveCourtFromCnj(parseCnjNumber(cnjFor(segment, tr))).alias).toBe(alias);
  });

  it("resolves the real TRF1 sample case", () => {
    expect(resolveCourtFromCnj(parseCnjNumber("0000832-35.2018.4.01.3202")).alias).toBe("trf1");
  });

  it("explains that STF data is not published", () => {
    expect(() => resolveCourtFromCnj(parseCnjNumber(cnjFor(1, 0)))).toThrow(/STF/);
  });

  it.each([
    [4, 9],
    [8, 30],
    [9, 1],
    [2, 0],
  ])("rejects unmapped segment %i court %i", (segment, tr) => {
    expect(() => resolveCourtFromCnj(parseCnjNumber(cnjFor(segment, tr)))).toThrow(
      UnsupportedCourtError,
    );
  });
});
