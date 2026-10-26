import { describe, expect, it } from "vitest";
import {
  caseByNumberQuery,
  decodeCursor,
  encodeCursor,
  InvalidFilterError,
  searchCasesQuery,
  toCompactDate,
} from "../../src/datajud/query.js";

describe("toCompactDate", () => {
  it("converts ISO dates to DataJud's compact format", () => {
    expect(toCompactDate("2023-01-05", "start")).toBe("20230105000000");
    expect(toCompactDate("2023-12-31", "end")).toBe("20231231235959");
  });

  it.each(["2023/01/05", "05-01-2023", "2023-02-30", "2023-13-01"])("rejects %s", (value) => {
    expect(() => toCompactDate(value, "start")).toThrow(InvalidFilterError);
  });
});

describe("cursor", () => {
  it("round-trips search_after values", () => {
    const sort = [1681366085550, "abc"];
    expect(decodeCursor(encodeCursor(sort))).toEqual(sort);
  });

  it("rejects garbage", () => {
    expect(() => decodeCursor("not-a-cursor")).toThrow(/nextCursor/);
  });
});

describe("caseByNumberQuery", () => {
  it("matches on numeroProcesso and can restrict _source to movements", () => {
    expect(caseByNumberQuery("00008323520184013202")).toEqual({
      size: 20,
      query: { match: { numeroProcesso: "00008323520184013202" } },
    });
    expect(caseByNumberQuery("1", { onlyMovements: true })._source).toContain("movimentos");
  });
});

describe("searchCasesQuery", () => {
  it("builds a filtered, sorted query with compact date range", () => {
    const query = searchCasesQuery({
      classCode: 1116,
      subjectCodes: [6017, 6018],
      courtUnitCode: 13597,
      filedFrom: "2023-01-01",
      filedTo: "2023-12-31",
      size: 5,
    });
    expect(query).toEqual({
      size: 5,
      _source: { excludes: ["movimentos"] },
      query: {
        bool: {
          must: [],
          filter: [
            { term: { "classe.codigo": 1116 } },
            { terms: { "assuntos.codigo": [6017, 6018] } },
            { term: { "orgaoJulgador.codigo": 13597 } },
            { range: { dataAjuizamento: { gte: "20230101000000", lte: "20231231235959" } } },
          ],
        },
      },
      sort: [{ "@timestamp": { order: "asc" } }],
    });
  });

  it("uses a match query for class names and adds search_after from the cursor", () => {
    const query = searchCasesQuery({
      className: "Execução Fiscal",
      size: 10,
      cursor: encodeCursor([42]),
    });
    expect(query.search_after).toEqual([42]);
    expect(JSON.stringify(query.query)).toContain('"operator":"and"');
  });

  it("requires at least one filter", () => {
    expect(() => searchCasesQuery({ size: 10 })).toThrow(/at least one filter/);
  });

  it("rejects inverted date ranges", () => {
    expect(() =>
      searchCasesQuery({ filedFrom: "2024-01-01", filedTo: "2023-01-01", size: 10 }),
    ).toThrow(/filedFrom/);
  });
});
