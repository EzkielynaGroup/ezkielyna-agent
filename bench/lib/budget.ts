/** Stops scheduling new task processes once accumulated reported/estimated spend reaches the cap. */
export class BudgetGuard {
  private total = 0

  constructor(private readonly limit: number) {
    if ((!Number.isFinite(limit) && limit !== Infinity) || limit < 0) throw new Error("budget must be a non-negative number")
  }

  get spent() {
    return this.total
  }

  canStart() {
    return this.total < this.limit
  }

  record(cost: number) {
    if (!Number.isFinite(cost) || cost < 0) throw new Error("task cost must be a finite non-negative number")
    this.total += cost
    return this.total
  }
}
