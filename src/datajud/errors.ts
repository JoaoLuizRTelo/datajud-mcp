export type DataJudErrorKind =
  | "auth"
  | "not_found"
  | "bad_query"
  | "rate_limited"
  | "upstream"
  | "timeout"
  | "network"
  | "invalid_response";

const RETRYABLE: ReadonlySet<DataJudErrorKind> = new Set([
  "rate_limited",
  "upstream",
  "timeout",
  "network",
]);

/** Every failure talking to DataJud is one of these, with a message written for the end user. */
export class DataJudError extends Error {
  override readonly name = "DataJudError";
  readonly retryable: boolean;

  constructor(
    readonly kind: DataJudErrorKind,
    message: string,
    readonly details: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.retryable = RETRYABLE.has(kind);
  }
}

interface EsErrorBody {
  error?: { type?: string; reason?: string; root_cause?: { type?: string; reason?: string }[] };
}

function esError(body: unknown): { type: string; reason: string } {
  const error = (body as EsErrorBody | null)?.error;
  const root = error?.root_cause?.[0];
  return {
    type: error?.type ?? root?.type ?? "unknown",
    reason: root?.reason ?? error?.reason ?? "",
  };
}

/** Parses `Retry-After` (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function errorFromResponse(
  status: number,
  body: unknown,
  index: string,
  retryAfter: string | null,
): DataJudError {
  const { type, reason } = esError(body);
  const retryAfterMs = parseRetryAfter(retryAfter);
  const details = { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };

  if (status === 401 || status === 403) {
    return new DataJudError(
      "auth",
      "DataJud rejected the API key. CNJ rotates the public key from time to time: copy the current " +
        "one from https://datajud-wiki.cnj.jus.br/api-publica/acesso into DATAJUD_API_KEY.",
      details,
    );
  }
  if (status === 404 || type === "index_not_found_exception") {
    return new DataJudError(
      "not_found",
      `DataJud has no index "${index}". Use the list_courts tool to pick a valid court.`,
      details,
    );
  }
  // Elasticsearch reports thread-pool saturation as es_rejected_execution_exception (usually 429).
  if (status === 429 || type === "es_rejected_execution_exception") {
    return new DataJudError(
      "rate_limited",
      "DataJud is rate limiting or overloaded. Try again in a minute.",
      details,
    );
  }
  if (status >= 500) {
    return new DataJudError(
      "upstream",
      `DataJud returned HTTP ${status}${reason ? `: ${reason}` : ""}. The service may be unstable.`,
      details,
    );
  }
  return new DataJudError(
    "bad_query",
    `DataJud rejected the query (HTTP ${status}, ${type})${reason ? `: ${reason}` : ""}.`,
    details,
  );
}
