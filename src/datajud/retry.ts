export interface RetryOptions {
  /** Total attempts including the first one. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Injected for deterministic tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

interface RetryableError {
  retryable?: boolean;
  details?: { retryAfterMs?: number };
}

export const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * "Full jitter" backoff (AWS Architecture Blog): a uniform random delay in
 * [0, min(cap, base * 2^(attempt-1))]. Spreads retries from concurrent clients instead of
 * synchronizing them into waves, which matters against a shared public API.
 */
export function backoffDelay(
  attempt: number,
  options: Pick<RetryOptions, "baseDelayMs" | "maxDelayMs" | "random">,
): number {
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor((options.random ?? Math.random)() * ceiling);
}

/** Retries `fn` while it throws errors marked `retryable`; honors a server `retryAfterMs` hint. */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const retryable = (error as RetryableError | null)?.retryable === true;
      if (!retryable || attempt >= options.maxAttempts) throw error;

      const hint = (error as RetryableError).details?.retryAfterMs;
      const delayMs =
        hint === undefined ? backoffDelay(attempt, options) : Math.min(hint, options.maxDelayMs);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
