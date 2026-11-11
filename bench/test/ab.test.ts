import { describe, expect, test } from "bun:test"
import { armLabel, pairedSignTest, parseArm } from "../lib/ab"

test("paired sign test ignores ties and reports the exact two-sided p-value", () => {
  expect(pairedSignTest([
    { aPass: false, bPass: true },
    { aPass: false, bPass: true },
    { aPass: true, bPass: false },
    { aPass: true, bPass: true },
  ])).toEqual({ aWins: 1, bWins: 2, ties: 1, n: 3, pValue: 1, tooSmall: true })
})

test("paired sign test marks small samples", () => {
  expect(pairedSignTest(Array.from({ length: 4 }, () => ({ aPass: false, bPass: true }))).tooSmall).toBe(true)
  expect(pairedSignTest(Array.from({ length: 10 }, () => ({ aPass: false, bPass: true }))).tooSmall).toBe(false)
})

describe("A/B arms", () => {
  test("the original feature-flag syntax still works, with or without the EZK_FEATURES= prefix", () => {
    expect(parseArm("EZK_FEATURES=-router", "A")).toEqual({ name: "A", agent: "ezkielyna", features: "-router" })
    expect(parseArm("-router,+mcp-defer", "B")).toEqual({ name: "B", agent: "ezkielyna", features: "-router,+mcp-defer" })
    expect(parseArm("", "A").features).toBe("")
    expect(armLabel(parseArm("", "A"))).toBe("EZK_FEATURES=(defaults)")
  })

  test("arms may differ by agent, and an arm may pin its model", () => {
    expect(parseArm("agent=upstream", "B")).toEqual({ name: "B", agent: "upstream", features: "" })
    expect(parseArm("agent=ezkielyna EZK_FEATURES=+mcp-defer model=deepseek-v4.1-flash", "A")).toEqual({
      name: "A",
      agent: "ezkielyna",
      features: "+mcp-defer",
      model: "deepseek-v4.1-flash",
    })
    expect(armLabel(parseArm("agent=upstream model=m", "B"))).toBe("agent=upstream model=m")
  })

  test("rejects unknown agents, unknown settings and feature flags on the upstream arm", () => {
    expect(() => parseArm("agent=codex", "A")).toThrow(/agent must be one of ezkielyna, upstream/)
    expect(() => parseArm("binary=/x", "A")).toThrow(/unknown setting/)
    expect(() => parseArm("agent=upstream EZK_FEATURES=-router", "B")).toThrow(/no effect on upstream/)
  })
})
