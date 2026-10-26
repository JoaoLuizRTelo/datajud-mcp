import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeCase,
  normalizeDate,
  normalizeMovement,
  rawSearchResponse,
  sortMovements,
} from "../../src/datajud/schemas.js";

const fixture: unknown = JSON.parse(
  readFileSync(new URL("../fixtures/trf1-case.json", import.meta.url), "utf8"),
);

describe("normalizeDate", () => {
  it.each([
    ["20181029000000", "2018-10-29T00:00:00.000Z"],
    ["20181029", "2018-10-29T00:00:00.000Z"],
    ["2018-10-30T14:06:24.000Z", "2018-10-30T14:06:24.000Z"],
    ["2026-06-08T14:55:23.378000Z", "2026-06-08T14:55:23.378Z"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDate(input)).toBe(expected);
  });

  it.each([undefined, "", "not a date"])("returns null for %j", (input) => {
    expect(normalizeDate(input)).toBeNull();
  });
});

describe("normalizeCase (recorded TRF1 response)", () => {
  const parsed = rawSearchResponse.parse(fixture);
  const hit = parsed.hits.hits[0];

  it("parses the live response shape", () => {
    expect(parsed.hits.total).toEqual({ value: 1, relation: "eq" });
    expect(hit).toBeDefined();
  });

  it("normalizes the case cover", () => {
    const record = normalizeCase(hit!._source);
    expect(record).toMatchObject({
      cnjNumber: "0000832-35.2018.4.01.3202",
      court: "TRF1",
      instance: "JE",
      class: { code: 436, name: "Procedimento do Juizado Especial Cível" },
      filedAt: "2018-10-29T00:00:00.000Z",
      secrecyLevel: 0,
    });
    expect(record.movementCount).toBeGreaterThan(0);
    expect(record.courtUnit.code).toBe(16403);
  });

  it("coerces string codes in movement court units", () => {
    const movements = (hit!._source.movimentos ?? []).map(normalizeMovement);
    expect(movements[0]).toMatchObject({
      code: 26,
      name: "Distribuição",
      courtUnit: "Tefé",
      hint: { kind: "filing" },
    });
    expect(movements[0]!.complements[0]).toEqual({
      name: "competência exclusiva",
      description: "tipo_de_distribuicao_redistribuicao",
    });
  });
});

describe("normalizeCase (drifted / sparse documents)", () => {
  it("tolerates missing optional fields", () => {
    const record = normalizeCase({ numeroProcesso: "00008323520184013202" });
    expect(record).toMatchObject({
      court: "",
      class: { code: null, name: "" },
      subjects: [],
      filedAt: null,
      movementCount: null,
    });
  });
});

describe("normalizeMovement hints", () => {
  it("explains context-free TPU leaf names and leaves unknown codes without a hint", () => {
    expect(normalizeMovement({ codigo: 245, nome: "Provisório" }).hint).toEqual({
      kind: "archival",
      label: "Records archived provisionally (may be reopened)",
    });
    expect(normalizeMovement({ codigo: 999_999, nome: "?" }).hint).toBeNull();
    expect(normalizeMovement({ nome: "no code" }).hint).toBeNull();
  });
});

describe("sortMovements", () => {
  const m = (at: string | null) => ({
    code: 1,
    name: "x",
    at,
    complements: [],
    courtUnit: null,
    hint: null,
  });

  it("sorts newest first and puts undated movements last", () => {
    const sorted = sortMovements([m("2020-01-01T00:00:00Z"), m(null), m("2022-01-01T00:00:00Z")]);
    expect(sorted.map((x) => x.at)).toEqual(["2022-01-01T00:00:00Z", "2020-01-01T00:00:00Z", null]);
  });

  it("supports ascending order", () => {
    const sorted = sortMovements([m("2022-01-01T00:00:00Z"), m("2020-01-01T00:00:00Z")], "asc");
    expect(sorted[0]!.at).toBe("2020-01-01T00:00:00Z");
  });
});
