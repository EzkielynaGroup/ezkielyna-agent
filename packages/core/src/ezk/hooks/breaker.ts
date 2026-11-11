import { STOP_BLOCK_LIMIT } from "./config"

/** Small stop-loop counter kept separate from the process-spawning hook engine. */
export class StopBreaker {
  private counts = new Map<string, number>()
  constructor(readonly limit = STOP_BLOCK_LIMIT) {}
  /** true = honour this block; false = the breaker is open, let the agent stop */
  block(sessionID: string) {
    const next = (this.counts.get(sessionID) ?? 0) + 1
    this.counts.set(sessionID, next)
    return next <= this.limit
  }
  active(sessionID: string) {
    return (this.counts.get(sessionID) ?? 0) > 0
  }
  reset(sessionID: string) {
    this.counts.delete(sessionID)
  }
}
