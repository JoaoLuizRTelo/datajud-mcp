import { defaultSleep } from "./retry.js";

/**
 * Sliding-window limiter: at most `limit` acquisitions in any `windowMs` window.
 * Unlike a token bucket it cannot burst to 2x the limit across a window boundary, so it keeps
 * us inside the DataJud Terms of Use (120 requests/minute, clause 3.13) under any traffic shape.
 */
export class SlidingWindowRateLimiter {
  private readonly timestamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly limit: number,
    private readonly windowMs = 60_000,
    private readonly clock: { now: () => number; sleep: (ms: number) => Promise<void> } = {
      now: Date.now,
      sleep: defaultSleep,
    },
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("limit must be a positive integer");
    }
  }

  /** Resolves when a request may be sent. Callers are served in FIFO order. */
  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.waitForSlot());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      while (this.timestamps.length > 0 && now - (this.timestamps[0] ?? 0) >= this.windowMs) {
        this.timestamps.shift();
      }
      if (this.timestamps.length < this.limit) {
        this.timestamps.push(now);
        return;
      }
      await this.clock.sleep((this.timestamps[0] ?? now) + this.windowMs - now);
    }
  }
}
