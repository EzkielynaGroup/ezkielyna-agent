/** Coordinates post-turn reviewers that share one small-model call budget per session turn. */
export class ReviewGate {
  private readonly claimed = new Set<string>()

  clear(sessionID: string) {
    this.claimed.delete(sessionID)
  }

  claim(sessionID: string) {
    if (this.claimed.has(sessionID)) return false
    this.claimed.add(sessionID)
    return true
  }
}
