import { expect, test } from "bun:test"
import { BudgetGuard } from "../lib/budget"

test("budget guard stops starting tasks when accrued cost reaches the cap", () => {
  const budget = new BudgetGuard(1)
  expect(budget.canStart()).toBe(true)
  budget.record(0.4)
  expect(budget.canStart()).toBe(true)
  budget.record(0.6)
  expect(budget.spent).toBe(1)
  expect(budget.canStart()).toBe(false)
})

test("a task that reaches or exceeds the cap prevents scheduling another task", () => {
  const budget = new BudgetGuard(1)
  budget.record(1.2)
  expect(budget.spent).toBe(1.2)
  expect(budget.canStart()).toBe(false)
})

test("invalid caps and costs are rejected", () => {
  expect(() => new BudgetGuard(Number.NaN)).toThrow()
  expect(() => new BudgetGuard(-1)).toThrow()
  expect(() => new BudgetGuard(1).record(Number.POSITIVE_INFINITY)).toThrow()
})
