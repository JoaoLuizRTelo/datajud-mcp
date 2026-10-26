import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  ServerNotification,
  ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DataJudSearcher } from "../datajud/client.js";
import { InvalidCnjNumberError, parseCnjNumber, type CnjNumber } from "../datajud/cnj-number.js";
import { COURT_ALIASES, resolveCourtFromCnj, UnsupportedCourtError } from "../datajud/courts.js";
import { DataJudError } from "../datajud/errors.js";
import { caseByNumberQuery, InvalidFilterError } from "../datajud/query.js";
import type { RawCase } from "../datajud/schemas.js";

export interface ToolDeps {
  datajud: DataJudSearcher;
  /** How often to send progress notifications while waiting on DataJud. */
  progressIntervalMs?: number;
}

export type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const DEFAULT_PROGRESS_INTERVAL_MS = 10_000;

/**
 * DataJud often needs 20-60 s, longer than many MCP clients' default request timeout (60 s in
 * the TypeScript SDK). When the client asked for progress (sent a progressToken), emit a
 * heartbeat so clients using `resetTimeoutOnProgress` keep waiting instead of giving up.
 */
export async function withProgress<T>(
  deps: ToolDeps,
  extra: ToolExtra,
  work: () => Promise<T>,
): Promise<T> {
  const token = extra._meta?.progressToken;
  if (token === undefined) return work();

  const started = Date.now();
  let beats = 0;
  const timer = setInterval(() => {
    beats++;
    const seconds = Math.round((Date.now() - started) / 1000);
    extra
      .sendNotification({
        method: "notifications/progress",
        params: {
          progressToken: token,
          progress: beats,
          message: `Waiting for DataJud (${seconds} s)`,
        },
      })
      .catch(() => undefined);
  }, deps.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS);
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export const cnjNumberInput = z
  .string()
  .min(20)
  .max(30)
  .describe(
    "CNJ unified case number, formatted (NNNNNNN-DD.AAAA.J.TR.OOOO) or as 20 digits. " +
      "Check digits are validated.",
  );

export const courtInput = z
  .enum(COURT_ALIASES)
  .describe(
    "DataJud court alias, e.g. 'tjsp', 'trf1', 'trt2', 'tre-sp', 'stj'. Optional when looking up a " +
      "case number: the origin court is derived from the number. Pass it explicitly to read the " +
      "record held by a higher court (e.g. 'stj'), since appeals keep the origin case number.",
  );

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

/** Successful result with both structured content and a JSON text fallback for older clients. */
export function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: structured,
    content: [{ type: "text", text: JSON.stringify(structured) }],
  };
}

/** Converts known failures into an `isError` result whose text tells the model what to do next. */
export function fail(error: unknown): CallToolResult {
  const known =
    error instanceof DataJudError ||
    error instanceof InvalidCnjNumberError ||
    error instanceof UnsupportedCourtError ||
    error instanceof InvalidFilterError;
  const message = known
    ? error.message
    : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
  return { isError: true, content: [{ type: "text", text: message }] };
}

export interface CaseLookup {
  cnj: CnjNumber;
  court: string;
  documents: RawCase[];
}

/** Validates the number, resolves the court and fetches every document (one per instance). */
export async function lookupCase(
  deps: ToolDeps,
  args: { cnjNumber: string; court?: string | undefined },
  options: { onlyMovements?: boolean; signal?: AbortSignal } = {},
): Promise<CaseLookup> {
  const cnj = parseCnjNumber(args.cnjNumber);
  const court = args.court ?? resolveCourtFromCnj(cnj).alias;
  const query = caseByNumberQuery(cnj.digits, { onlyMovements: options.onlyMovements ?? false });
  const response = await deps.datajud.search(court, query, { signal: options.signal });
  // `match` is analyzed; keep only exact hits so a fuzzy match can never leak another case.
  const documents = response.hits.hits
    .map((hit) => hit._source)
    .filter((doc) => doc.numeroProcesso === cnj.digits);
  return { cnj, court, documents };
}
