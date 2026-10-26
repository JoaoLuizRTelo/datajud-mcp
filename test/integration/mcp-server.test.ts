import { afterEach, describe, expect, it } from "vitest";
import { DataJudClient } from "../../src/datajud/client.js";
import { decodeCursor } from "../../src/datajud/query.js";
import { FixtureSearcher, readFixture } from "../../evals/fixture-searcher.js";
import { emptyResponse, fakeFetch, loadFixture, type FakeReply } from "../helpers/fake-fetch.js";
import { connect, textOf } from "../helpers/mcp.js";

const evalFixture = (name: string) =>
  readFixture(new URL(`../../evals/fixtures/${name}.json`, import.meta.url));

let session: Awaited<ReturnType<typeof connect>> | undefined;
afterEach(async () => {
  await session?.close();
  session = undefined;
});

/** Server backed by the real HTTP client with scripted HTTP replies. */
async function withHttp(replies: FakeReply[]) {
  const http = fakeFetch(replies);
  const datajud = new DataJudClient(
    {
      apiKey: "k",
      baseUrl: "https://datajud.test",
      timeoutMs: 1000,
      totalTimeoutMs: 60_000,
      maxAttempts: 3,
      requestsPerMinute: 120,
    },
    { fetch: http.fetch, sleep: () => Promise.resolve(), random: () => 0 },
  );
  session = await connect(datajud);
  return { ...session, http };
}

/** Server backed by recorded fixtures keyed by court and number. */
async function withFixtures(entries: [string, string][]) {
  const searcher = new FixtureSearcher(
    new Map(entries.map(([key, file]) => [key, evalFixture(file)])),
  );
  session = await connect(searcher);
  return { ...session, searcher };
}

describe("tool discovery", () => {
  it("exposes four read-only tools with input and output schemas", async () => {
    const { client } = await withFixtures([]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_case",
      "list_courts",
      "list_movements",
      "search_cases",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(50);
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("get_case", () => {
  it("resolves the court from the number and returns the normalized record", async () => {
    const { call, http } = await withHttp([{ status: 200, body: loadFixture("trf1-case.json") }]);
    const result = await call("get_case", { cnjNumber: "0000832-35.2018.4.01.3202" });

    expect(result.isError).toBeFalsy();
    expect(http.calls[0]!.url).toBe("https://datajud.test/api_publica_trf1/_search");
    expect(result.structuredContent).toMatchObject({
      court: "trf1",
      cnjNumber: "0000832-35.2018.4.01.3202",
      found: true,
      records: [{ court: "TRF1", instance: "JE", class: { code: 436 } }],
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it("returns one record per instance", async () => {
    const { call } = await withFixtures([["trf4:50003042620244047112", "trf4-multi-instance"]]);
    const result = await call("get_case", { cnjNumber: "5000304-26.2024.4.04.7112" });
    const records = (result.structuredContent as { records: { instance: string }[] }).records;
    expect(records.map((r) => r.instance).sort()).toEqual(["JE", "TR"]);
  });

  it("reads a higher court's record when `court` is given explicitly", async () => {
    const { call, searcher } = await withFixtures([
      ["stj:10352894820228260602", "stj-final-discharge"],
    ]);
    const result = await call("get_case", { cnjNumber: "1035289-48.2022.8.26.0602", court: "stj" });
    expect(searcher.calls[0]!.court).toBe("stj");
    expect(result.structuredContent).toMatchObject({ found: true, records: [{ instance: "SUP" }] });
  });

  it("reports found: false for an unknown case", async () => {
    const { call } = await withHttp([{ status: 200, body: emptyResponse }]);
    const result = await call("get_case", { cnjNumber: "0000001-05.2025.8.26.0100" });
    expect(result.structuredContent).toMatchObject({ court: "tjsp", found: false, records: [] });
  });

  it("rejects a mistyped number before calling DataJud", async () => {
    const { call, http } = await withHttp([]);
    const result = await call("get_case", { cnjNumber: "0000832-36.2018.4.01.3202" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/check digits are 36 but should be 35/);
    expect(http.calls).toHaveLength(0);
  });

  it("rejects an unknown court alias through schema validation", async () => {
    const { call } = await withHttp([]);
    const result = await call("get_case", { cnjNumber: "00008323520184013202", court: "tjxx" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/court/);
  });

  it("explains STF numbers are not available", async () => {
    const { call } = await withHttp([]);
    // Valid check digits, segment 1 (STF).
    const result = await call("get_case", { cnjNumber: "0000001-53.2024.1.00.0001" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/STF/);
  });

  it("recovers from a 503 and surfaces an auth error clearly", async () => {
    const recovering = await withHttp([
      { status: 503 },
      { status: 200, body: loadFixture("trf1-case.json") },
    ]);
    const ok = await recovering.call("get_case", { cnjNumber: "00008323520184013202" });
    expect(ok.isError).toBeFalsy();
    expect(recovering.http.calls).toHaveLength(2);
    await recovering.close();

    const failing = await withHttp([
      { status: 401, body: { error: { type: "security_exception" } } },
    ]);
    const result = await failing.call("get_case", { cnjNumber: "00008323520184013202" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/DATAJUD_API_KEY/);
  });
});

describe("list_movements", () => {
  it("returns newest movements first with hints, limited per instance", async () => {
    const { call, searcher } = await withFixtures([
      ["tjdft:07133834320258070006", "tjdft-judgment-granted"],
    ]);
    const result = await call("list_movements", {
      cnjNumber: "0713383-43.2025.8.07.0006",
      limit: 3,
    });
    const output = result.structuredContent as {
      instances: {
        totalMovements: number;
        latestMovementAt: string;
        movements: { code: number; hint: unknown }[];
      }[];
    };
    const [instance] = output.instances;
    expect(instance!.totalMovements).toBe(63);
    expect(instance!.movements).toHaveLength(3);
    expect(instance!.movements.map((m) => m.code)).toContain(219);
    expect(instance!.movements.find((m) => m.code === 219)!.hint).toMatchObject({
      kind: "decision",
    });
    expect(instance!.latestMovementAt.startsWith("2026-10-08")).toBe(true);
    expect(searcher.calls[0]!.body._source).toContain("movimentos");
  });

  it("filters by `since` and supports ascending order", async () => {
    const { call } = await withFixtures([["tjdft:07133834320258070006", "tjdft-judgment-granted"]]);
    const result = await call("list_movements", {
      cnjNumber: "07133834320258070006",
      since: "2026-05-13",
      order: "asc",
    });
    const movements = (result.structuredContent as { instances: { movements: { at: string }[] }[] })
      .instances[0]!.movements;
    expect(movements.length).toBeGreaterThan(0);
    expect(movements.every((m) => m.at >= "2026-05-13")).toBe(true);
    expect(movements[0]!.at <= movements.at(-1)!.at).toBe(true);
  });
});

describe("search_cases", () => {
  const hit = (n: string, sort: number) => ({
    _id: n,
    _source: {
      numeroProcesso: n,
      tribunal: "TJDFT",
      grau: "G1",
      classe: { codigo: 1116, nome: "Execução Fiscal" },
    },
    sort: [sort],
  });

  it("sends compact dates and returns a cursor for the next page", async () => {
    const { call, http } = await withHttp([
      {
        status: 200,
        body: {
          hits: {
            total: { value: 970, relation: "eq" },
            hits: [hit("07134929520238070016", 1), hit("07535123120238070016", 2)],
          },
        },
      },
    ]);
    const result = await call("search_cases", {
      court: "tjdft",
      classCode: 1116,
      filedFrom: "2023-01-01",
      filedTo: "2023-12-31",
      size: 2,
    });

    expect(JSON.stringify(http.calls[0]!.body)).toContain('"gte":"20230101000000"');
    const output = result.structuredContent as {
      total: { value: number };
      results: { cnjNumber: string; movementCount: number | null }[];
      nextCursor: string;
    };
    expect(output.total.value).toBe(970);
    expect(output.results[0]).toMatchObject({
      cnjNumber: "0713492-95.2023.8.07.0016",
      movementCount: null,
    });
    expect(decodeCursor(output.nextCursor)).toEqual([2]);
  });

  it("returns a null cursor on the last page", async () => {
    const { call } = await withHttp([
      {
        status: 200,
        body: {
          hits: { total: { value: 1, relation: "eq" }, hits: [hit("07134929520238070016", 1)] },
        },
      },
    ]);
    const result = await call("search_cases", { court: "tjdft", classCode: 1116, size: 10 });
    expect(result.structuredContent).toMatchObject({ nextCursor: null });
  });

  it("requires at least one filter", async () => {
    const { call, http } = await withHttp([]);
    const result = await call("search_cases", { court: "tjdft" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/at least one filter/);
    expect(http.calls).toHaveLength(0);
  });
});

describe("list_courts", () => {
  it("filters by segment", async () => {
    const { call } = await withFixtures([]);
    const all = await call("list_courts");
    const federal = await call("list_courts", { segment: "federal" });
    expect((all.structuredContent as { courts: unknown[] }).courts).toHaveLength(91);
    expect(
      (federal.structuredContent as { courts: { alias: string }[] }).courts.map((c) => c.alias),
    ).toEqual(["trf1", "trf2", "trf3", "trf4", "trf5", "trf6"]);
  });
});
