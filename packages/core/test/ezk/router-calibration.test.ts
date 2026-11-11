// Fixed offline v2 calibration gate. The held-out 70/30 split is defined in fixtures/router-labels.md.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyIntent, type Intent } from "../../src/ezk/intent/classify"
import { classify } from "../../src/ezk/router/classify"

type Tier = "light" | "heavy"
interface Row {
  id: number | string
  label: Tier
  intent: Intent
  lang: "id" | "en"
  category: string
  split: "train" | "test"
  prompt: string
}
const load = (): Row[] =>
  readFileSync(join(import.meta.dir, "fixtures", "router-prompts.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))

const tiers: Tier[] = ["heavy", "light"]
const intents: Intent[] = ["fix", "plan-needed", "qa", "other"]

function tierScore(rows: Row[]) {
  const cm: Record<Tier, Record<Tier, number>> = {
    heavy: { heavy: 0, light: 0 },
    light: { heavy: 0, light: 0 },
  }
  for (const row of rows) cm[row.label][classify({ prompt: row.prompt }).tier]++
  const correct = tiers.reduce((sum, truth) => sum + cm[truth][truth], 0)
  return {
    cm,
    accuracy: correct / rows.length,
    weightedErrors: 2 * cm.heavy.light + cm.light.heavy,
    heavyMissRate: cm.heavy.light / Math.max(1, cm.heavy.heavy + cm.heavy.light),
  }
}

function intentScore(rows: Row[]) {
  const cm = Object.fromEntries(intents.map((truth) => [truth, Object.fromEntries(intents.map((pred) => [pred, 0]))])) as Record<
    Intent,
    Record<Intent, number>
  >
  for (const row of rows) cm[row.intent][classifyIntent(row.prompt)]++
  const correct = intents.reduce((sum, truth) => sum + cm[truth][truth], 0)
  return { cm, accuracy: correct / rows.length }
}

const all = load()

describe("router calibration v2", () => {
  test("dataset has the fixed 250 prompt 70/30 split and both languages/intents", () => {
    expect(all).toHaveLength(250)
    expect(new Set(all.map((row) => String(row.id))).size).toBe(250)
    expect(all.filter((row) => row.split === "train")).toHaveLength(175)
    expect(all.filter((row) => row.split === "test")).toHaveLength(75)
    expect(all.filter((row) => String(row.id).startsWith("bench-") || row.category.startsWith("bench-")).length).toBe(30)
    expect(all.filter((row) => typeof row.id === "number" && row.id >= 181).length).toBe(70)
    expect(new Set(all.map((row) => row.label))).toEqual(new Set(tiers))
    expect(new Set(all.map((row) => row.intent))).toEqual(new Set(intents))
    expect(new Set(all.map((row) => row.lang))).toEqual(new Set(["id", "en"]))
  })

  test("held-out tier accuracy stays at least 85% with the safety-weighted error bound", () => {
    const score = tierScore(all.filter((row) => row.split === "test"))
    expect(score.accuracy).toBeGreaterThanOrEqual(0.85)
    expect(score.heavyMissRate).toBeLessThanOrEqual(0.1)
    // A heavy→light miss has twice the cost of a light→heavy miss.
    expect(score.weightedErrors).toBeLessThanOrEqual(9)
  })

  test("held-out intent accuracy stays at least 85% across all four labels", () => {
    const rows = all.filter((row) => row.split === "test")
    const score = intentScore(rows)
    expect(score.accuracy).toBeGreaterThanOrEqual(0.85)
    for (const intent of intents) expect(rows.some((row) => row.intent === intent)).toBe(true)
  })
})
