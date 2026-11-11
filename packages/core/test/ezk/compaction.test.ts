import { describe, expect, test } from "bun:test"
import { DEFAULT_FLAGS, loadFlags } from "../../src/ezk/flags"
import { DEFAULT_POLICY, mergePolicy } from "../../src/ezk/model-policy"
import {
  RECENT_USER_TOKEN_BUDGET,
  clearOldToolResults,
  compactionIneffective,
  compactionThreshold,
  modelCompactionThreshold,
  recipePrompt,
  recentUserMessages,
  toolResultMarker,
} from "../../src/ezk/compaction"

describe("C2 compaction recipe", () => {
  test("uses published model metadata and vision by default, with per-field kill switches", () => {
    expect(DEFAULT_FLAGS.models).toEqual({ metadata: true, vision: true })
    expect(loadFlags([], {}).models).toEqual({ metadata: true, vision: true })
    expect(loadFlags([], { EZK_FEATURES: "-models.metadata,-models.vision" }).models).toEqual({
      metadata: false,
      vision: false,
    })
    expect(loadFlags([], { EZK_FEATURES: "-models.vision" }).models).toEqual({ metadata: true, vision: false })
  })

  test("is default OFF and can be explicitly enabled by EZK_FEATURES", () => {
    expect(DEFAULT_FLAGS.compaction.enabled).toBe(false)
    expect(loadFlags([], {}).compaction.enabled).toBe(false)
    expect(loadFlags([], { EZK_FEATURES: "+compaction" }).compaction.enabled).toBe(true)
  })

  test("uses 90% of a real model window and keeps the caller fallback when unknown", () => {
    expect(compactionThreshold(200_000, 77_000)).toBe(180_000)
    expect(compactionThreshold(undefined, 77_000)).toBe(77_000)
    expect(compactionThreshold(0, 77_000)).toBe(77_000)
  })

  test("reads the real window from model-policy metadata and falls back for unknown models", () => {
    const policy = mergePolicy(DEFAULT_POLICY, {
      models: {
        "known-model": { agentContext: 300_000 },
        "deepseek-v4.1-flash": { agentContext: 262_144 },
      },
    })
    expect(modelCompactionThreshold(policy, "known-model", 77_000)).toBe(270_000)
    expect(modelCompactionThreshold(policy, "deepseek-v4.1-flash", 77_000)).toBe(235_929)
    expect(modelCompactionThreshold(policy, "unknown-model", 77_000)).toBe(77_000)
  })

  test("treats a 20% reduction as effective for the breaker", () => {
    expect(compactionIneffective(100_000, 80_000)).toBe(false)
    expect(compactionIneffective(100_000, 80_001)).toBe(true)
    expect(compactionIneffective(0, 0)).toBe(true)
  })

  test("clears the oldest tool outputs first and keeps calls represented by line-count markers", () => {
    const outputs = ["old\noutput\nlarge", "middle\nlarge", "newest"]
    const cleared = clearOldToolResults({
      items: outputs,
      output: (item) => item,
      replace: (_item, marker) => marker,
      keepTokens: 3,
      minimumFreedTokens: 1,
      estimate: (text) => text.startsWith("[output dibuang") ? 1 : text.length,
    })
    expect(cleared.items[0]).toBe("[output dibuang saat ringkasan: 3 baris]")
    expect(cleared.items[1]).toBe("[output dibuang saat ringkasan: 2 baris]")
    expect(cleared.items[2]).toBe("newest")
    expect(toolResultMarker("")).toBe("[output dibuang saat ringkasan: 0 baris]")
    expect(toolResultMarker("one\n")).toBe("[output dibuang saat ringkasan: 1 baris]")
  })

  test("preserves newest user messages verbatim within the soft 20k token budget", () => {
    const messages = ["first\nexact", "middle exact", "newest\nexact", "assistant"]
    const recent = recentUserMessages({
      messages,
      isUser: (message) => message !== "assistant",
      text: (message) => message,
      budget: 4,
      estimate: (text) => text.length,
    })
    expect(recent).toEqual(["newest\nexact"])
    expect(RECENT_USER_TOKEN_BUDGET).toBe(20_000)
  })

  test("builds the fixed handoff sections with focus and restored plan/file context", () => {
    const prompt = recipePrompt({
      focus: "carry the database migration risks",
      conversation: "[User]: Implement migration",
      previousSummary: "Prior decision: keep backwards compatibility",
      recentUsers: ["Please preserve this wording exactly."],
      context: ["Approved plan: migrate in two steps", "Recently read file src/db.ts:\nexport const db = 1"],
    })
    for (const text of [
      "carry the database migration risks",
      "## Goal",
      "## Decisions",
      "## Files Touched",
      "## Open TODOs",
      "## Errors Seen",
      "## Next Step",
      "Approved plan: migrate in two steps",
      "Recently read file src/db.ts",
      "Please preserve this wording exactly.",
    ]) expect(prompt).toContain(text)
  })
})
