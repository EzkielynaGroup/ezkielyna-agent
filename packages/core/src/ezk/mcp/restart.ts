// Crash-restart budget for local MCP servers: at most `max` restarts inside a rolling window, then a clear error.
export class RestartGate {
  private stamps = new Map<string, number[]>()
  constructor(
    private max = 2,
    private windowMs = 10 * 60_000,
    private now: () => number = Date.now,
  ) {}

  /** Returns the attempt number (1-based) when a restart is allowed, or undefined when the budget is spent. */
  take(name: string): number | undefined {
    const t = this.now()
    const list = (this.stamps.get(name) ?? []).filter((x) => t - x < this.windowMs)
    if (list.length >= this.max) {
      this.stamps.set(name, list)
      return undefined
    }
    list.push(t)
    this.stamps.set(name, list)
    return list.length
  }

  reset(name: string) {
    this.stamps.delete(name)
  }

  /** Delay before attempt n: 500 ms, then 2 s. */
  static delayMs(attempt: number) {
    return attempt <= 1 ? 500 : 2000
  }

  static failureMessage(name: string, max: number, last?: string) {
    return `MCP server "${name}" stopped unexpectedly and was restarted ${max} time${max === 1 ? "" : "s"} without success${last ? ` (last error: ${last})` : ""}. Fix the server command, then reconnect it from the MCP panel.`
  }
}
