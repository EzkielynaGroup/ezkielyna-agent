import { expect, test } from "bun:test"
import { sessionUsage } from "./session-usage"

test("session usage combines uncached, cached, and output tokens without double-counting reasoning", () => {
  expect(
    sessionUsage({
      input: 1_000,
      output: 300,
      reasoning: 120,
      cache: { read: 600, write: 100 },
    }),
  ).toEqual({ totalTokens: 2_000, cacheHitPercent: 600 / 1_700 * 100 })
})

test("session usage omits cache percentage when no prompt tokens were reported", () => {
  expect(
    sessionUsage({
      input: 0,
      output: 40,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  ).toEqual({ totalTokens: 40, cacheHitPercent: undefined })
  expect(sessionUsage(undefined)).toBeUndefined()
})
