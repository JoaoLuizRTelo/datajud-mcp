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

/** Narrow interface the tools depend on, so tests and evals can swap in a fixture-backed fake. */
export interface DataJudSearcher {
  search(court: string, body: EsQuery): Promise<RawSearchResponse>;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 20_000;

export class DataJudClient implements DataJudSearcher {
  private readonly fetch: typeof globalThis.fetch;
  private readonly limiter: SlidingWindowRateLimiter;

  constructor(
    private readonly config: DataJudConfig,
    private readonly deps: DataJudClientDeps = {},
  ) {
    this.fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.limiter = new SlidingWindowRateLimiter(config.requestsPerMinute, 60_000, {
      now: deps.now ?? Date.now,
      sleep: deps.sleep ?? defaultSleep,
    });
  }

  /** POST `/<index>/_search` with rate limiting, a per-attempt timeout and retries. */
  async search(court: string, body: EsQuery): Promise<RawSearchResponse> {
    const index = indexName(court);
    return withRetry(
      async () => {
        await this.limiter.acquire();
        return this.searchOnce(index, body);
      },
      {
        maxAttempts: this.config.maxAttempts,
        baseDelayMs: BASE_DELAY_MS,
        maxDelayMs: MAX_DELAY_MS,
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

  private async searchOnce(index: string, body: EsQuery): Promise<RawSearchResponse> {
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
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new DataJudError(
          "timeout",
          `DataJud did not answer within ${Math.round(this.config.timeoutMs / 1000)} s. ` +
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
    return parsed.data;
  }
}
