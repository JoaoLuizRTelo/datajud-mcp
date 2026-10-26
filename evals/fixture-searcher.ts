import { readFileSync } from "node:fs";
import type { DataJudSearcher } from "../src/datajud/client.js";
import type { EsQuery } from "../src/datajud/query.js";
import { rawSearchResponse, type RawSearchResponse } from "../src/datajud/schemas.js";

const EMPTY: RawSearchResponse = { hits: { total: { value: 0, relation: "eq" }, hits: [] } };

export function readFixture(path: string | URL): RawSearchResponse {
  return rawSearchResponse.parse(JSON.parse(readFileSync(path, "utf8")));
}

/**
 * Offline stand-in for DataJud: answers case-number lookups from recorded responses, keyed by
 * `<court>:<20 digits>`. Used by integration tests and evals so they run without network access.
 */
export class FixtureSearcher implements DataJudSearcher {
  readonly calls: { court: string; body: EsQuery }[] = [];

  constructor(private readonly fixtures: Map<string, RawSearchResponse>) {}

  search(court: string, body: EsQuery): Promise<RawSearchResponse> {
    this.calls.push({ court, body });
    const digits = (body.query as { match?: { numeroProcesso?: string } } | undefined)?.match
      ?.numeroProcesso;
    return Promise.resolve(this.fixtures.get(`${court}:${digits ?? ""}`) ?? EMPTY);
  }
}
