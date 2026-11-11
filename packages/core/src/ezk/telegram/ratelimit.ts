// Per-user token bucket. `capacity` messages burst, refilled evenly over `windowMs`. Injectable clock for tests.
export class RateLimiter {
  private buckets = new Map<number, { tokens: number; at: number }>()
  constructor(
    private capacity = 10,
    private windowMs = 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Returns 0 when allowed (and consumes a token), else the milliseconds until the next token. */
  take(userId: number): number {
    const t = this.now()
    const b = this.buckets.get(userId) ?? { tokens: this.capacity, at: t }
    b.tokens = Math.min(this.capacity, b.tokens + ((t - b.at) * this.capacity) / this.windowMs)
    b.at = t
    this.buckets.set(userId, b)
    if (this.buckets.size > 1000) this.prune(t)
    if (b.tokens >= 1) {
      b.tokens -= 1
      return 0
    }
    return Math.ceil(((1 - b.tokens) * this.windowMs) / this.capacity)
  }

  private prune(t: number) {
    for (const [id, b] of this.buckets) if (t - b.at > this.windowMs * 2) this.buckets.delete(id)
  }
}
