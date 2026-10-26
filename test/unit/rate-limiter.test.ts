import { describe, expect, it } from "vitest";
import { SlidingWindowRateLimiter } from "../../src/datajud/rate-limiter.js";

/** Virtual clock: `sleep` advances time instantly. */
function virtualClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

describe("SlidingWindowRateLimiter", () => {
  it("lets `limit` requests through immediately", async () => {
    const clock = virtualClock();
    const limiter = new SlidingWindowRateLimiter(3, 60_000, clock);
    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);
    expect(clock.now()).toBe(0);
  });

  it("delays the next request until the oldest one leaves the window", async () => {
    const clock = virtualClock();
    const limiter = new SlidingWindowRateLimiter(2, 60_000, clock);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      await limiter.acquire();
      times.push(clock.now());
    }
    expect(times).toEqual([0, 0, 60_000, 60_000, 120_000]);
  });

  it("never exceeds the limit in any window", async () => {
    const clock = virtualClock();
    const limiter = new SlidingWindowRateLimiter(120, 60_000, clock);
    const times: number[] = [];
    await Promise.all(
      Array.from({ length: 400 }, () => limiter.acquire().then(() => times.push(clock.now()))),
    );
    for (const t of times) {
      expect(times.filter((x) => x >= t && x < t + 60_000).length).toBeLessThanOrEqual(120);
    }
  });

  it("rejects invalid limits", () => {
    expect(() => new SlidingWindowRateLimiter(0)).toThrow(RangeError);
  });
});
