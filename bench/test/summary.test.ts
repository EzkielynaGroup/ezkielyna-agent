import { expect, test } from "bun:test"
import { estimateCost, estimateCostForModels, parsePrice } from "../lib/cost"
import { compare, costOf, renderSummary, type Result } from "../lib/summary"

const result = (id: string, pass: boolean, extra: Partial<Result> = {}): Result => ({
  id,
  category: id.split("-")[0]!,
  lang: "id",
  pass,
  reason: pass ? "" : "verify exited 1",
  turns: 4,
  duration_ms: 10_000,
  verify_ms: 100,
  tool_calls: 3,
  tool_errors: 0,
  edit_failures: 0,
  tool_error_details: [],
  agent_errors: [],
  exit_code: 0,
  timed_out: false,
  tokens: { input: 1000, output: 100, reasoning: 0, cache_read: 3000, cache_write: 0 },
  cost: 0,
  cost_estimated: 0.002,
  cache_hit_ratio: 0.75,
  missing_keywords: [],
  model: "ezkielyna/ezk-auto",
  agent_mode: "run",
  features: "+router.log",
  dry_run: false,
  ...extra,
})

const meta = {
  model: "ezkielyna/ezk-auto",
  version: "1.0",
  bin: "ezkielyna",
  mode: "run",
  features: "+router.log",
  dryRun: false,
  budget: 1,
  started: "now",
}

test("summary headline and failures", () => {
  const text = renderSummary(
    [result("bugfix-01", true), result("qa-01", false, { edit_failures: 1, tool_errors: 1 })],
    meta,
  )
  expect(text).toContain("**1/2 passed (50%)**")
  expect(text).toContain("1 edit failure(s)")
  expect(text).toContain("cache hit 75%")
  expect(text).toContain("- **qa-01**: verify exited 1")
})

test("baseline comparison lists flipped tasks and deltas", () => {
  const before = [result("bugfix-01", false), result("bugfix-02", true), result("qa-01", true, { turns: 8 })]
  const now = [result("bugfix-01", true), result("bugfix-02", false), result("qa-01", true), result("data-01", true)]
  const text = compare(now, before).join("\n")
  expect(text).toContain("On the 3 task(s) present in both runs.")
  expect(text).toContain("| Passed | 2/3 | 2/3 | 0 |")
  expect(text).toContain("Newly passing: bugfix-01")
  expect(text).toContain("Newly failing: bugfix-02")
  expect(text).toContain("Not in the baseline: data-01")
  expect(text).toContain("| Avg turns | 5.3 | 4.0 | -1.3 |")
})

test("a partial run is compared only on its own tasks", () => {
  const before = [result("bugfix-01", true), result("bugfix-02", true), result("qa-01", false)]
  const text = compare([result("bugfix-01", true)], before).join("\n")
  expect(text).toContain("| Passed | 1/1 | 1/1 | 0 |")
})

test("cost charged is the larger of reported and estimated", () => {
  expect(costOf({ cost: 0, cost_estimated: 0.5 })).toBe(0.5)
  expect(costOf({ cost: 0.7, cost_estimated: 0.5 })).toBe(0.7)
  expect(costOf({ cost: 0.1 })).toBe(0.1)
})

test("cost estimate from --price or the router price table", () => {
  const tokens = { input: 1_000_000, output: 1_000_000, reasoning: 0, cache_read: 1_000_000, cache_write: 0 }
  expect(estimateCost(tokens, "ezkielyna/anything", parsePrice("1/0.1/2"))).toEqual({ usd: 3.1, source: "--price" })
  const table = estimateCost(tokens, "ezkielyna/deepseek-v4.1-flash")
  expect(table?.source).toBe("pricing.ts:deepseek-v4.1-flash")
  expect(table!.usd).toBeGreaterThan(0)
  expect(estimateCost(tokens, "ezkielyna/unknown-model")?.source).toContain("pricing.ts:conservative-max:")
  expect(() => parsePrice("cheap")).toThrow()
})

test("auto-router aggregate usage is priced at its costliest observed model", () => {
  const tokens = { input: 10_000, output: 1_000, reasoning: 0, cache_read: 0, cache_write: 0 }
  const estimate = estimateCostForModels(tokens, ["deepseek-v4.1-flash", "deepseek-v4-pro-0813"])
  expect(estimate?.source).toBe("pricing.ts:deepseek-v4-pro-0813")
  expect(estimate?.usd).toBeGreaterThan(estimateCost(tokens, "deepseek-v4.1-flash")!.usd)
})
