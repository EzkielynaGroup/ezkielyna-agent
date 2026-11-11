// Allowlist of Telegram user ids + one-time pairing code. Anyone not on the list is refused before any agent call.
import { randomInt, timingSafeEqual } from "node:crypto"

export class Allowlist {
  private ids: Set<number>
  constructor(ids: Iterable<number> = []) {
    this.ids = new Set([...ids].filter((n) => Number.isSafeInteger(n) && n > 0))
  }
  has(id: unknown): boolean {
    return typeof id === "number" && this.ids.has(id)
  }
  add(id: number) {
    if (Number.isSafeInteger(id) && id > 0) this.ids.add(id)
  }
  remove(id: number) {
    this.ids.delete(id)
  }
  replace(ids: Iterable<number>) {
    this.ids = new Set([...ids].filter((n) => Number.isSafeInteger(n) && n > 0))
  }
  list(): number[] {
    return [...this.ids]
  }
}

/** Pairing code printed in the owner's terminal. 8 digits, single use, expires, limited attempts. */
export class Pairing {
  private code: string | undefined
  private expires = 0
  private attempts = 0
  constructor(
    private ttlMs = 10 * 60_000,
    private maxAttempts = 5,
    private now: () => number = Date.now,
  ) {}
  issue(): string {
    this.code = String(randomInt(0, 100_000_000)).padStart(8, "0")
    this.expires = this.now() + this.ttlMs
    this.attempts = 0
    return this.code
  }
  /** True once, for the right code in time. Wrong guesses burn attempts; too many invalidates the code. */
  redeem(candidate: string): boolean {
    if (!this.code || this.now() > this.expires) return false
    if (++this.attempts > this.maxAttempts) {
      this.code = undefined
      return false
    }
    const a = Buffer.from(candidate.trim().padEnd(8, " ").slice(0, 8))
    const b = Buffer.from(this.code)
    if (candidate.trim().length !== 8 || !timingSafeEqual(a, b)) return false
    this.code = undefined
    return true
  }
}
