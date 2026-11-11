// P4: the one-line usage summary at the end of `run`.
import { describe, expect, test } from "bun:test"
import { STATIC_PRICES, costUSD } from "@opencode-ai/core/ezk/pricing"
import { UsageTally, formatUsd, usageLine } from "../../src/ezk/usage-line"

describe("formatUsd", () => {
  test("under one cent shows four decimals, otherwise two", () => {
    expect(formatUsd(0.0042)).toBe("$0.0042")
    expect(formatUsd(0)).toBe("$0.0000")
    expect(formatUsd(0.00999)).toBe("$0.0100")
    expect(formatUsd(0.01)).toBe("$0.01")
    expect(formatUsd(1.2749)).toBe("$1.27")
  })
})

describe("usageLine", () => {
  const totals = { input: 12345, cached: 9000, output: 678, cost: 0.0042 }
  test("English", () => expect(usageLine(totals, "en")).toBe("Usage: 12,345 tokens in (9,000 cached), 678 out, cost $0.0042"))
  test("Indonesian", () => expect(usageLine(totals, "id")).toBe("Pemakaian: 12.345 token masuk (9.000 dari cache), 678 keluar, biaya $0.0042"))
  test("it is one line", () => expect(usageLine(totals, "en")).not.toContain("\n"))
})

describe("UsageTally", () => {
  const message = (id: string, tokens: object, extra: object = {}) => ({ id, role: "assistant", providerID: "ezkielyna", modelID: "deepseek-v4.1-flash", time: { completed: 1 }, tokens, cost: 0, ...extra })

  test("sums completed assistant messages: in = input + cache, out = output + reasoning; the latest state of a message wins", () => {
    const tally = new UsageTally()
    tally.seen(message("m1", { input: 100, output: 10, reasoning: 5, cache: { read: 900, write: 0 } }))
    tally.seen(message("m1", { input: 100, output: 10, reasoning: 5, cache: { read: 900, write: 0 } })) // repeated event
    tally.seen(message("m2", { input: 50, output: 20, cache: { read: 0, write: 50 } }))
    tally.seen({ ...message("m3", { input: 1, output: 1 }), time: {} }) // not completed
    tally.seen({ id: "u1", role: "user", time: { completed: 1 }, tokens: { input: 999 } }) // not an assistant message
    const t = tally.totals(() => undefined)
    expect(tally.count).toBe(2)
    expect(t).toMatchObject({ input: 1100, cached: 900, output: 35, turns: 2 })
  })

  test("Ezkielyna models are priced from the price book, other providers report their own cost", () => {
    const tally = new UsageTally()
    tally.seen(message("m1", { input: 1_000_000, output: 0, cache: { read: 0, write: 0 } }))
    tally.seen(message("m2", { input: 5, output: 5 }, { providerID: "openai", modelID: "x", cost: 0.25 }))
    const prices = (model: string) => STATIC_PRICES[model]
    const expected = costUSD(STATIC_PRICES["deepseek-v4.1-flash"], { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }) + 0.25
    expect(tally.totals(prices).cost).toBeCloseTo(expected, 8)
  })
})
