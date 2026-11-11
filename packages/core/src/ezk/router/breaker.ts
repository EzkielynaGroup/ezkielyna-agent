// Ezkielyna Agent v1.1: per-model circuit breaker.
// Hard failures (401/402/403/404 = group, quota or model closed for this key) open it for 30 min.
// Soft failures (429, 5xx, timeouts, network) open it for 2 min after 2 strikes. A success closes it.
import type { BreakerEntry } from "../contracts"

export const HARD_STATUSES = [401, 402, 403, 404]
export const HARD_OPEN_MS = 30 * 60_000
export const SOFT_OPEN_MS = 2 * 60_000
export const SOFT_STRIKES = 2

/** status 0 = timeout / network error. */
export const isHardStatus = (status: number) => HARD_STATUSES.includes(status)

interface Health {
  strikes: number
  openUntil: number
  reason: string
}

export class Breaker {
  private health = new Map<string, Health>()
  constructor(private now: () => number = Date.now) {}

  isOpen(model: string, at = this.now()) {
    const h = this.health.get(model)
    return !!h && h.openUntil > at
  }

  failure(model: string, status: number, reason?: string) {
    const h = this.health.get(model) ?? { strikes: 0, openUntil: 0, reason: "" }
    h.strikes += 1
    const label = reason ?? (status === 0 ? "timeout/network" : `HTTP ${status}`)
    if (isHardStatus(status)) {
      h.openUntil = this.now() + HARD_OPEN_MS
      h.reason = label
    } else if (h.strikes >= SOFT_STRIKES) {
      h.openUntil = this.now() + SOFT_OPEN_MS
      h.reason = label
    }
    this.health.set(model, h)
  }

  success(model: string) {
    this.health.delete(model)
  }

  open(at = this.now()): BreakerEntry[] {
    const out: BreakerEntry[] = []
    for (const [model, h] of this.health) if (h.openUntil > at) out.push({ model, openUntil: h.openUntil, reason: h.reason })
    return out
  }

  reset() {
    this.health.clear()
  }
}
