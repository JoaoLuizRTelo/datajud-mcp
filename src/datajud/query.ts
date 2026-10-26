/**
 * Builders for the Elasticsearch Query DSL that DataJud accepts.
 * Kept free of I/O so they can be unit-tested and reused by the agent's pre-check.
 */

export type EsQuery = Record<string, unknown>;

/** Fields we never need when listing search results; movements can be thousands of entries. */
const SEARCH_EXCLUDES = ["movimentos"];

export function caseByNumberQuery(
  digits: string,
  options: { onlyMovements?: boolean } = {},
): EsQuery {
  return {
    size: 20,
    query: { match: { numeroProcesso: digits } },
    ...(options.onlyMovements
      ? { _source: ["numeroProcesso", "tribunal", "grau", "movimentos"] }
      : {}),
  };
}

export interface CaseFilters {
  classCode?: number | undefined;
  className?: string | undefined;
  subjectCodes?: number[] | undefined;
  courtUnitCode?: number | undefined;
  /** Inclusive, `YYYY-MM-DD`. */
  filedFrom?: string | undefined;
  /** Inclusive, `YYYY-MM-DD`. */
  filedTo?: string | undefined;
  size: number;
  cursor?: string | undefined;
}

export class InvalidFilterError extends Error {
  override readonly name = "InvalidFilterError";
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * DataJud stores `dataAjuizamento` as `yyyyMMddHHmmss`. A range query with ISO dates is
 * accepted by the API but silently matches nothing, so every date goes through here.
 */
export function toCompactDate(isoDate: string, boundary: "start" | "end"): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) {
    throw new InvalidFilterError(`Invalid date "${isoDate}": use the format YYYY-MM-DD.`);
  }
  const [, y, m, d] = match;
  const parsed = new Date(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.getUTCDate() !== Number(d)) {
    throw new InvalidFilterError(`Invalid date "${isoDate}": that day does not exist.`);
  }
  return `${y}${m}${d}${boundary === "start" ? "000000" : "235959"}`;
}

export function encodeCursor(sort: unknown[]): string {
  return Buffer.from(JSON.stringify(sort), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): unknown[] {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (Array.isArray(value)) return value;
  } catch {
    // fall through
  }
  throw new InvalidFilterError(
    "Invalid cursor: pass the exact `nextCursor` value returned by a previous search.",
  );
}

export function searchCasesQuery(filters: CaseFilters): EsQuery {
  const must: EsQuery[] = [];
  const filter: EsQuery[] = [];

  if (filters.classCode !== undefined) {
    filter.push({ term: { "classe.codigo": filters.classCode } });
  }
  if (filters.className) {
    must.push({ match: { "classe.nome": { query: filters.className, operator: "and" } } });
  }
  if (filters.subjectCodes?.length) {
    filter.push({ terms: { "assuntos.codigo": filters.subjectCodes } });
  }
  if (filters.courtUnitCode !== undefined) {
    filter.push({ term: { "orgaoJulgador.codigo": filters.courtUnitCode } });
  }
  if (filters.filedFrom || filters.filedTo) {
    const range: Record<string, string> = {};
    if (filters.filedFrom) range.gte = toCompactDate(filters.filedFrom, "start");
    if (filters.filedTo) range.lte = toCompactDate(filters.filedTo, "end");
    if (range.gte && range.lte && range.gte > range.lte) {
      throw new InvalidFilterError("filedFrom must be on or before filedTo.");
    }
    filter.push({ range: { dataAjuizamento: range } });
  }

  if (must.length === 0 && filter.length === 0) {
    throw new InvalidFilterError(
      "Provide at least one filter (classCode, className, subjectCodes, courtUnitCode, filedFrom or filedTo).",
    );
  }

  return {
    size: filters.size,
    _source: { excludes: SEARCH_EXCLUDES },
    query: { bool: { must, filter } },
    // search_after pagination requires a deterministic sort; this is the one CNJ documents.
    sort: [{ "@timestamp": { order: "asc" } }],
    ...(filters.cursor ? { search_after: decodeCursor(filters.cursor) } : {}),
  };
}
