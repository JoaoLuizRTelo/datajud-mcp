import { describe, expect, it, vi } from "vitest";
import { backoffDelay, withRetry } from "../../src/datajud/retry.js";

const retryable = (extra: object = {}) =>
  Object.assign(new Error("transient"), { retryable: true, details: {}, ...extra });

describe("backoffDelay (full jitter)", () => {
  const opts = { baseDelayMs: 1000, maxDelayMs: 20_000 };

  it("grows the ceiling exponentially and caps it", () => {
    const max = () => 0.999_999;
    expect(backoffDelay(1, { ...opts, random: max })).toBe(999);
    expect(backoffDelay(2, { ...opts, random: max })).toBe(1999);
    expect(backoffDelay(4, { ...opts, random: max })).toBe(7999);
    expect(backoffDelay(10, { ...opts, random: max })).toBe(19_999);
  });

  it("stays within [0, ceiling] for any random value", () => {
    for (let i = 0; i < 1000; i++) {
      const d = backoffDelay(3, opts);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(4000);
    }
  });
});

describe("withRetry", () => {
  const base = { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 20_000, random: () => 0.5 };

  it("retries retryable errors and returns the eventual result", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(retryable())
      .mockRejectedValueOnce(retryable())
      .mockResolvedValue("ok");

    await expect(withRetry(fn, { ...base, sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[500], [1000]]);
  });

  it("does not retry non-retryable errors", async () => {
    const fn = vi.fn(() => Promise.reject(new Error("bad request")));
    await expect(withRetry(fn, { ...base, sleep: () => Promise.resolve() })).rejects.toThrow(
      "bad request",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn(() => Promise.reject(retryable()));
    await expect(withRetry(fn, { ...base, sleep: () => Promise.resolve() })).rejects.toThrow(
      "transient",
    );
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("honors a Retry-After hint, capped at maxDelayMs", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const fn = vi
      .fn<(attempt: number) => Promise<string>>()
      .mockRejectedValueOnce(retryable({ details: { retryAfterMs: 3000 } }))
      .mockRejectedValueOnce(retryable({ details: { retryAfterMs: 999_999 } }))
      .mockResolvedValue("ok");

    await withRetry(fn, { ...base, sleep });
    expect(sleep.mock.calls).toEqual([[3000], [20_000]]);
  });

  it("stops retrying when the next wait would pass the deadline", async () => {
    let now = 0;
    const sleep = vi.fn((ms: number) => {
      now += ms;
      return Promise.resolve();
    });
    const fn = vi.fn(() => Promise.reject(retryable()));
    // Delays with random 0.5: 500, 1000, 2000... Deadline 1200 allows only the first wait.
    await expect(
      withRetry(fn, { ...base, maxAttempts: 10, sleep, now: () => now, deadline: 1200 }),
    ).rejects.toThrow("transient");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[500]]);
  });

  it("works with real timers", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi
        .fn<(attempt: number) => Promise<string>>()
        .mockRejectedValueOnce(retryable())
        .mockResolvedValue("ok");
      const promise = withRetry(fn, base);
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });
});
