import { describe, expect, test } from "bun:test"
import { SKILL_DESCRIPTION_MAX, SKILL_LIST_BUDGET, budgetSkills, reviewerModelFor } from "../../src/ezk/skills/disclosure"
import { reviewTask, REVIEW_MODEL } from "../../src/ezk/skills"
import { PriceBook } from "../../src/ezk/pricing"

describe("E2 progressive disclosure", () => {
  test("each description is one line and at most 1,536 chars", () => {
    const b = budgetSkills([{ name: "a", description: "x\n".repeat(2000) }])
    expect(b.entries[0]!.description.includes("\n")).toBe(false)
    expect(b.entries[0]!.description.length).toBeLessThanOrEqual(SKILL_DESCRIPTION_MAX)
  })

  test("total stays within the 8k budget; no skill is dropped when descriptions can shrink", () => {
    const list = Array.from({ length: 20 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "d".repeat(1500) }))
    const b = budgetSkills(list)
    const size = b.entries.reduce((n, e) => n + e.name.length + e.description.length, 0)
    expect(size).toBeLessThanOrEqual(SKILL_LIST_BUDGET)
    expect(b.entries.length).toBe(20)
    expect(b.shortened).toBe(true)
  })

  test("a huge list drops the tail and says how many", () => {
    const list = Array.from({ length: 400 }, (_, i) => ({ name: `s-${String(i).padStart(3, "0")}`, description: "does a thing" }))
    const b = budgetSkills(list)
    expect(b.omitted).toBeGreaterThan(0)
    expect(b.entries.length + b.omitted).toBe(400)
  })

  test("skills without a description are not listed; small lists are untouched", () => {
    const b = budgetSkills([{ name: "b", description: "two" }, { name: "a", description: "one" }, { name: "c" }])
    expect(b.entries.map((e) => e.name)).toEqual(["a", "b"])
    expect(b.shortened).toBe(false)
    expect(b.omitted).toBe(0)
  })
})

describe("E2 reviewer model follows the key's own light chain", () => {
  test("Flash-only key: picks its Flash model, not the default-model alias", () => {
    expect(reviewerModelFor(["deepseek-v4.1-flash"])).toBe("deepseek-v4.1-flash")
    expect(reviewerModelFor(["minimax-m3.1-flash", "glm-5.3-flash"])).toBe("minimax-m3.1-flash")
  })
  test("cheapest by price when prices are known", () => {
    const prices = new PriceBook()
    expect(reviewerModelFor(["minimax-m3.1-flash", "deepseek-v4.1-flash"], { price: (id) => prices.get(id) })).toBe("deepseek-v4.1-flash")
  })
  test("never a heavy or Pro-only model; alias only as last resort; nothing usable -> undefined", () => {
    expect(reviewerModelFor(["deepseek-v4-pro-0813", "claude-opus-5.5"])).toBeUndefined()
    expect(reviewerModelFor(["deepseek-v4-pro-0813", "fast-model"])).toBe("fast-model")
    expect(reviewerModelFor([])).toBeUndefined()
  })
  test("reviewTask sends the chosen model (default stays the alias)", async () => {
    const seen: string[] = []
    const call = async (r: { model: string }) => (seen.push(r.model), { text: '{"proposal":null}', usage: { inputTokens: 10, outputTokens: 5 } })
    await reviewTask({ enabled: true, digest: "d", call, model: reviewerModelFor(["deepseek-v4.1-flash"]) })
    await reviewTask({ enabled: true, digest: "d", call })
    expect(seen).toEqual(["deepseek-v4.1-flash", REVIEW_MODEL])
  })
})
