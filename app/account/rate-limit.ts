// In-process limiters. The server is a single Node process, so memory is the
// right place for short-lived counters; they intentionally reset on restart.

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  readonly limit: number;
  readonly windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  private recent(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Remaining requests in the current window, without recording a hit. */
  remaining(key: string, now = Date.now()) {
    return Math.max(0, this.limit - this.recent(key, now).length);
  }

  /** Milliseconds until the oldest hit leaves the window (0 when not limited). */
  retryAfterMs(key: string, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length < this.limit) return 0;
    return Math.max(0, list[0] + this.windowMs - now);
  }

  /** Records a hit when allowed; returns false (without recording) when the key is over the limit. */
  tryHit(key: string, now = Date.now()) {
    const list = this.recent(key, now);
    if (list.length >= this.limit) return false;
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > 10_000) this.sweep(now);
    return true;
  }

  private sweep(now: number) {
    for (const key of Array.from(this.hits.keys())) this.recent(key, now);
  }
}

export class ConcurrencyGate {
  private active = 0;
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  get inFlight() {
    return this.active;
  }

  /** Returns a release function, or null when the gate is full. Release is idempotent. */
  tryAcquire() {
    if (this.active >= this.max) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}
