import type { DataJudConfig } from "../config.js";
import { indexName } from "./courts.js";
import { DataJudError, errorFromResponse } from "./errors.js";
import type { EsQuery } from "./query.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { defaultSleep, withRetry } from "./retry.js";
import { rawSearchResponse, type RawSearchResponse } from "./schemas.js";

export interface DataJudClientDeps {
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Diagnostics sink. Must not write to stdout: stdout carries the MCP protocol. */
  log?: (message: string) => void;
}

export interface SearchOptions {
  /** Aborts the search (e.g. when the MCP client cancels the tool call). Never retried. */
  signal?: AbortSignal | undefined;
}

/** Narrow interface the tools depend on, so tests and evals can swap in a fixture-backed fake. */
export interface DataJudSearcher {
  search(court: string, body: EsQuery, options?: SearchOptions): Promise<RawSearchResponse>;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 20_000;

export class DataJudClient implements DataJudSearcher {
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(
    private readonly config: DataJudConfig,
    private readonly deps: DataJudClientDeps = {},
  ) {
    this.fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = deps.now ?? Date.now;
    this.limiter = new SlidingWindowRateLimiter(config.requestsPerMinute, 60_000, {
      now: this.now,
      sleep: deps.sleep ?? defaultSleep,
    });
  }

  /**
   * POST `/<index>/_search` with rate limiting, retries and two time limits: `timeoutMs` per
   * attempt and `totalTimeoutMs` across attempts, so a struggling API fails in bounded time.
   */
  async search(
    court: string,
    body: EsQuery,
    options: SearchOptions = {},
  ): Promise<RawSearchResponse> {
    const index = indexName(court);
    const deadline = this.now() + this.config.totalTimeoutMs;
    return withRetry(
      async () => {
        await this.limiter.acquire();
        const remaining = Math.max(1, deadline - this.now());
        return this.searchOnce(
          index,
          body,
          Math.min(this.config.timeoutMs, remaining),
          options.signal,
        );
      },
      {
        maxAttempts: this.config.maxAttempts,
        baseDelayMs: BASE_DELAY_MS,
        maxDelayMs: MAX_DELAY_MS,
        deadline,
        now: this.now,
        ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
        ...(this.deps.random ? { random: this.deps.random } : {}),
        onRetry: ({ attempt, delayMs, error }) => {
          const reason = error instanceof Error ? error.message : String(error);
          this.deps.log?.(
            `[datajud] ${index} attempt ${attempt} failed (${reason}); retrying in ${delayMs} ms`,
          );
        },
      },
    );
  }

  private async searchOnce(
    index: string,
    body: EsQuery,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<RawSearchResponse> {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetch(`${this.config.baseUrl}/${index}/_search`, {
        method: "POST",
        headers: {
          Authorization: `APIKey ${this.config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (callerSignal?.aborted) {
        throw new DataJudError("cancelled", "The request was cancelled.", { cause: error });
      }
      if (
        timeoutSignal.aborted ||
        (error instanceof DOMException && error.name === "TimeoutError")
      ) {
        throw new DataJudError(
          "timeout",
          `DataJud did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
            "The API is often slow; retrying or narrowing the query usually helps.",
          { cause: error },
        );
      }
      throw new DataJudError("network", `Could not reach DataJud: ${String(error)}`, {
        cause: error,
      });
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      throw errorFromResponse(response.status, json, index, response.headers.get("retry-after"));
    }

    const parsed = rawSearchResponse.safeParse(json);
    if (!parsed.success) {
      throw new DataJudError(
        "invalid_response",
        `DataJud returned a response in an unexpected format: ${parsed.error.issues[0]?.message ?? "unknown"}`,
        { status: response.status, cause: parsed.error },
      );
    }
    // Elasticsearch can answer 200 while some shards failed (DataJud does this when overloaded).
    // Partial hits are dangerous here: a case on a failed shard would look "not found", and the
    // agent's pre-check could miss new movements. Retry instead of returning incomplete data.
    const shards = parsed.data._shards;
    if (shards && shards.failed > 0) {
      throw new DataJudError(
        "partial_results",
        `DataJud is overloaded and answered from only ${shards.successful} of ${shards.total} ` +
          "shards, so results would be incomplete. Try again in a minute.",
        { status: response.status },
      );
    }
    return parsed.data;
  }
}
