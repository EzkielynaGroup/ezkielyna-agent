import { describe, expect, test } from "bun:test"
import { Breaker, HARD_OPEN_MS, SOFT_OPEN_MS } from "../../src/ezk/router/breaker"
import { classify, parseTierPrefix, tinyClassify } from "../../src/ezk/router/classify"
import { RouterEngine, STICKY_MS, isError, MAX_ESCALATIONS } from "../../src/ezk/router/engine"
import { DEFAULT_POLICY } from "../../src/ezk/model-policy"
import { PriceBook } from "../../src/ezk/pricing"
import { DEFAULT_FLAGS } from "../../src/ezk/flags"
import { ProCapability } from "../../src/ezk/router/capability"
import { SessionSignals } from "../../src/ezk/router/signals"

const LABELED: [string, "heavy" | "light", any?][] = [
  ["rename variable foo to bar in utils.ts", "light"],
  ["explain what this function does", "light"],
  ["fix the typo in README", "light"],
  ["run the tests and show me the failures", "light"],
  ["create hello.py that prints fizzbuzz then run it", "light"],
  ["add a docstring to parse_config", "light"],
  ["jelaskan apa itu middleware di file ini", "light"],
  ["ganti nama fungsi getData jadi fetchData", "light"],
  ["what is the difference between these two files", "light"],
  ["git status", "light"],
  ["summarize the last commit", "light"],
  ["translate the error messages to Indonesian", "light"],
  ["Refactor the auth module to use the new session store across the codebase and update all callers", "heavy"],
  ["Design the architecture for a plugin system and implement the first module, with tests", "heavy"],
  ["There is a race condition in the job queue that only shows up intermittently. Find the root cause.", "heavy"],
  ["Migrate the whole project from express to hono, keep behavior identical", "heavy"],
  ["migrasi database dari sqlite ke postgres dan perbarui seluruh repo", "heavy"],
  ["audit keamanan untuk endpoint login dan perbaiki semua masalah", "heavy"],
  ["Implement a new feature: export sessions to markdown.\n- must support folders\n- keep images\n- add CLI flag\n- add tests\n- update docs", "heavy"],
  ['why does this crash?\n```\nTraceback (most recent call last):\n  File "a.py", line 3\n```', "light"],
  ["tests keep failing after my change, please fix", "heavy", { failingLoop: 3, filesTouched: 5 }],
  ["continue", "heavy", { failingLoop: 2, toolErrors: 4 }],
  ["make a plan to rewrite the renderer", "heavy", { planMode: true }],
  ["ok thanks", "light"],
]

describe("classify", () => {
  test("labelled smoke set >= 85%", () => {
    let ok = 0
    for (const [prompt, want, extra] of LABELED) if (classify({ prompt, ...extra }).tier === want) ok++
    expect(ok / LABELED.length).toBeGreaterThanOrEqual(0.85)
  })
  test("score is clamped and ambiguous band reported", () => {
    const c = classify({ prompt: "x".repeat(10), failingLoop: 9, planMode: true, filesTouched: 99, toolErrors: 9, contextTokens: 99999 })
    expect(c.score).toBeLessThanOrEqual(100)
    expect(classify({ prompt: "" }).score).toBeGreaterThanOrEqual(0)
    // 30 base, no signals: 14 words stays below the band, 16 words (+8 length prior) lands on its lower edge.
    expect(classify({ prompt: "word ".repeat(14) }).ambiguous).toBe(false)
    expect(classify({ prompt: "word ".repeat(16) }).ambiguous).toBe(true) // 30 + 8 = 38
  })
  test("tier prefix", () => {
    expect(parseTierPrefix("@heavy fix it")).toEqual({ forced: "heavy", text: "fix it" })
    expect(parseTierPrefix("  @LIGHT   hi")).toEqual({ forced: "light", text: "hi" })
    expect(parseTierPrefix("email me @heavy")).toEqual({ text: "email me @heavy" })
  })
  test("decision overhead p95 <= 5 ms", () => {
    const e = engine(ALL_STD)
    const times: number[] = []
    for (let i = 0; i < 2000; i++) {
      const t = performance.now()
      e.decide("s", `m${i}`, { prompt: "Refactor the auth module across the codebase and update callers. ".repeat(5), filesTouched: 4 })
      times.push(performance.now() - t)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(5)
  })
})

describe("tinyClassify", () => {
  test("respects the budget", async () => {
    const t0 = performance.now()
    const v = await tinyClassify("x", () => new Promise((r) => setTimeout(() => r("heavy"), 1000)), 100)
    expect(v).toBeUndefined()
    expect(performance.now() - t0).toBeLessThan(400)
  })
  test("parses a one word answer and survives errors", async () => {
    expect(await tinyClassify("x", async () => "Heavy.")).toBe("heavy")
    expect(await tinyClassify("x", async () => "light")).toBe("light")
    expect(await tinyClassify("x", async () => "maybe")).toBeUndefined()
    expect(await tinyClassify("x", async () => { throw new Error("boom") })).toBeUndefined()
  })
})

describe("breaker", () => {
  test("hard statuses open 30 min, soft need 2 strikes then 2 min", () => {
    let t = 1_000_000
    const b = new Breaker(() => t)
    for (const s of [401, 402, 403, 404]) {
      b.failure(`m${s}`, s)
      expect(b.isOpen(`m${s}`)).toBe(true)
    }
    t += HARD_OPEN_MS - 1
    expect(b.isOpen("m403")).toBe(true)
    t += 2
    expect(b.isOpen("m403")).toBe(false)
    b.failure("soft", 503)
    expect(b.isOpen("soft")).toBe(false)
    b.failure("soft", 0)
    expect(b.isOpen("soft")).toBe(true)
    t += SOFT_OPEN_MS + 1
    expect(b.isOpen("soft")).toBe(false)
  })
  test("success closes and clears strikes", () => {
    const b = new Breaker()
    b.failure("a", 503)
    b.success("a")
    b.failure("a", 503)
    expect(b.isOpen("a")).toBe(false)
    expect(b.open()).toEqual([])
    b.failure("a", 403)
    expect(b.open()[0]?.reason).toBe("HTTP 403")
    b.reset()
    expect(b.open()).toEqual([])
  })
})

const ALL_STD = ["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "minimax-m3.1-flash", "default-model", "fast-model", "auto"]
const FLASH_ONLY = ["deepseek-v4.1-flash", "minimax-m3.1-flash"]
const PREMIUM = [...ALL_STD, "claude-opus-5.5", "claude-opus-5", "claude-sonnet-5.5", "gpt-6-luna"]
const HEAVY_PROMPT = "Refactor the whole repo to a new architecture across the codebase"

function engine(ids: string[], over: Partial<{ now: () => number; cap: number; pro: boolean }> = {}) {
  const e = new RouterEngine({
    policy: DEFAULT_POLICY,
    prices: new PriceBook(),
    flags: { ...DEFAULT_FLAGS.router, capUSD: over.cap ?? 1 },
    now: over.now,
    proEnabled: () => over.pro === true,
  })
  e.setAllowed(ids)
  return e
}
const model = (d: ReturnType<RouterEngine["decide"]>) => {
  if (isError(d)) throw new Error(d.error)
  return d.model
}

describe("engine decide", () => {
  test("default-group key: heavy -> v4-pro, light -> flash", () => {
    const e = engine(ALL_STD)
    expect(model(e.decide("s1", "m1", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4-pro-0813")
    expect(model(e.decide("s2", "m1", { prompt: "rename foo to bar" }))).toBe("deepseek-v4.1-flash")
  })
  test("Flash-plan key runs both tiers on Flash", () => {
    const e = engine(FLASH_ONLY)
    expect(model(e.decide("s", "m", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4.1-flash")
    expect(model(e.decide("s2", "m", { prompt: "rename foo to bar" }))).toBe("deepseek-v4.1-flash")
  })
  test("never routes outside the allowed set; Claude never chosen without the capability", () => {
    const e = engine(PREMIUM)
    const d = e.decide("s", "m", { prompt: HEAVY_PROMPT })
    expect(model(d)).toBe("deepseek-v4-pro-0813")
    const e2 = engine(PREMIUM, { pro: true })
    expect(model(e2.decide("s", "m", { prompt: HEAVY_PROMPT }))).toBe("claude-opus-5.5")
    expect(model(e2.decide("s2", "m", { prompt: "rename foo to bar" }))).toBe("claude-sonnet-5.5")
  })
  test("gateway alias is the last resort when no named model is allowed", () => {
    const e = engine(["default-model"])
    expect(model(e.decide("s", "m", { prompt: "hi" }))).toBe("default-model")
  })
  test("error when nothing is routable", () => {
    const e = engine([])
    expect(isError(e.decide("s", "m", { prompt: "hi" }))).toBe(true)
  })
  test("forced tier and tiny tie-breaker", () => {
    const e = engine(ALL_STD)
    expect(model(e.decide("s", "m", { prompt: "rename x" }, { forced: "heavy" }))).toBe("deepseek-v4-pro-0813")
    const amb = "word ".repeat(16)
    const e2 = engine(ALL_STD)
    expect(model(e2.decide("s", "m", { prompt: amb }, { tiny: "heavy" }))).toBe("deepseek-v4-pro-0813")
    expect(model(engine(ALL_STD).decide("s", "m", { prompt: amb }, { tiny: "light" }))).toBe("deepseek-v4.1-flash")
  })
  test("breaker skips closed models and the chain moves on", () => {
    const e = engine(ALL_STD)
    e.breaker.failure("deepseek-v4-pro-0813", 403)
    expect(model(e.decide("s", "m", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4.1-flash")
    e.breaker.failure("deepseek-v4.1-flash", 404)
    e.breaker.failure("minimax-m3.1-flash", 404)
    // glm/mimo/etc not allowed => aliases
    expect(model(e.decide("s2", "m", { prompt: HEAVY_PROMPT }))).toBe("default-model")
  })
  test("everything open: still tries the best candidate instead of dead-ending", () => {
    const e = engine(FLASH_ONLY)
    for (const m of FLASH_ONLY) e.breaker.failure(m, 403)
    const d = e.decide("s", "m", { prompt: "hi" })
    expect(model(d)).toBe("deepseek-v4.1-flash")
    expect((d as any).reason).toContain("marked unavailable")
  })
  test("recovery after the breaker window", () => {
    let t = 1_000_000
    const e = engine(ALL_STD, { now: () => t })
    e.breaker.failure("deepseek-v4-pro-0813", 403)
    expect(model(e.decide("s", "m1", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4.1-flash")
    t += HARD_OPEN_MS + 1
    expect(model(e.decide("s2", "m2", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4-pro-0813")
  })
})

describe("engine stickiness", () => {
  test("short follow-ups keep the session tier until a new task arrives", () => {
    const e = engine(ALL_STD)
    expect(model(e.decide("follow", "m1", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4-pro-0813")
    const next = e.decide("follow", "m2", { prompt: "oke, continue with the next step." }) as any
    expect(next.tier).toBe("heavy")
    expect(next.reason).toContain("short follow-up keeps previous tier")

    const light = engine(ALL_STD)
    expect(model(light.decide("follow", "m1", { prompt: "rename foo to bar" }))).toBe("deepseek-v4.1-flash")
    expect((light.decide("follow", "m2", { prompt: "oke perbaiki itu" }) as any).tier).toBe("light")
    expect((light.decide("follow", "m3", { prompt: HEAVY_PROMPT }, { forced: "heavy" }) as any).tier).toBe("heavy")
  })

  test("after a fallback the session keeps the new model (cache), then returns to the preferred one", () => {
    let t = 1_000_000
    const e = engine(ALL_STD, { now: () => t })
    expect(model(e.decide("s", "m1", { prompt: "rename foo to bar" }))).toBe("deepseek-v4.1-flash")
    // soft failure fallback: only one strike so the breaker stays closed
    e.breaker.failure("deepseek-v4.1-flash", 503)
    expect(e.next("s", "deepseek-v4.1-flash")).toBe("minimax-m3.1-flash")
    e.noteSwitch("s", "deepseek-v4.1-flash", "minimax-m3.1-flash")
    t += 60_000
    const d = e.decide("s", "m2", { prompt: "rename foo to bar" }) as any
    expect(d.model).toBe("minimax-m3.1-flash")
    expect(d.sticky).toBe(true)
    t += STICKY_MS
    expect(model(e.decide("s", "m3", { prompt: "rename foo to bar" }))).toBe("deepseek-v4.1-flash")
  })
  test("tier change picks the tier's preferred model (no stale stickiness)", () => {
    const e = engine(ALL_STD)
    e.decide("s", "m1", { prompt: "rename foo to bar" })
    expect(model(e.decide("s", "m2", { prompt: HEAVY_PROMPT }))).toBe("deepseek-v4-pro-0813")
  })
  test("heavy -> light hysteresis keeps heavy unless clearly light", () => {
    const e = engine(ALL_STD)
    e.decide("s", "m1", { prompt: HEAVY_PROMPT })
    const mid = e.decide("s", "m2", { prompt: "ok now update the callers and the docs accordingly so everything stays consistent with the new design please", filesTouched: 3 }) as any
    expect(mid.tier).toBe("heavy")
    const clear = e.decide("s", "m3", { prompt: "git status" }) as any
    expect(clear.tier).toBe("light")
  })
})

describe("engine escalate", () => {
  test("failing loop escalates light -> heavy at most twice per message", () => {
    const e = engine(ALL_STD)
    e.decide("s", "m1", { prompt: "fix the failing test" })
    expect(e.escalate("s", { failingLoop: 1 })).toBeUndefined()
    const up = e.escalate("s", { failingLoop: 2 })!
    expect(up.model).toBe("deepseek-v4-pro-0813")
    expect(up.escalatedFrom).toBe("deepseek-v4.1-flash")
    expect(up.tier).toBe("heavy")
    expect(e.escalate("s", { failingLoop: 3 })).toBeUndefined() // already heavy
    // new message resets
    e.decide("s", "m2", { prompt: "git status" })
    expect(MAX_ESCALATIONS).toBe(2)
  })
  test("no escalation on a key that has no heavier model", () => {
    const e = engine(FLASH_ONLY)
    e.decide("s", "m1", { prompt: "fix the failing test" })
    expect(e.escalate("s", { failingLoop: 5 })).toBeUndefined()
  })
  test("pinned/unknown sessions never escalate", () => {
    const e = engine(ALL_STD)
    expect(e.escalate("never-routed", { failingLoop: 5 })).toBeUndefined()
  })
})

describe("engine cost cap", () => {
  test("downgrades to Flash when spent + estimate would pass the cap", () => {
    const e = engine(ALL_STD, { cap: 0.01 })
    e.setMessageCost("s", "a1", 0.0099)
    const d = e.decide("s", "m", { prompt: HEAVY_PROMPT }) as any
    expect(d.downgraded).toBe(true)
    expect(d.model).toBe("deepseek-v4.1-flash")
    expect(d.reason).toContain("cap")
  })
  test("cap reached => Flash even for the cheap tier choice", () => {
    const e = engine(ALL_STD, { cap: 0.5 })
    e.setMessageCost("s", "a1", 0.6)
    const d = e.decide("s", "m", { prompt: HEAVY_PROMPT }) as any
    expect(d.downgraded).toBe(true)
    e.decide("s", "m1", { prompt: "fix the failing test" })
    expect(e.capReached("s")).toBe(true)
    expect(e.escalate("s", { failingLoop: 5 })).toBeUndefined()
  })
  test("cost is idempotent per message and 0 disables the cap", () => {
    const e = engine(ALL_STD, { cap: 0 })
    e.setMessageCost("s", "a1", 5)
    e.setMessageCost("s", "a1", 5)
    expect(e.spentUSD("s")).toBe(5)
    expect(((e.decide("s", "m", { prompt: HEAVY_PROMPT })) as any).downgraded).toBeUndefined()
  })
})

describe("pro capability scaffold", () => {
  test("hidden by default; visible only with flag + listed + fresh probe + closed breaker", async () => {
    let t = 1_000
    const e = engine(PREMIUM, { now: () => t })
    const off = new ProCapability(e, () => false, () => t)
    await off.probe("claude-opus-5.5", async () => 200)
    expect(off.visible()).toBe(false)
    const cap = new ProCapability(e, () => true, () => t)
    expect(cap.visible()).toBe(false) // no probe yet
    expect(await cap.probe("claude-opus-5.5", async () => 200)).toBe(true)
    expect(cap.visible()).toBe(true)
    t += 25 * 3600_000
    expect(cap.visible()).toBe(false) // probe is stale
    expect(await cap.probe("claude-opus-5.5", async () => 403)).toBe(false)
    expect(e.breaker.isOpen("claude-opus-5.5")).toBe(true)
    expect(cap.visible()).toBe(false)
  })
  test("not listed for the key => hidden", async () => {
    const e = engine(ALL_STD)
    const cap = new ProCapability(e, () => true)
    await cap.probe("claude-opus-5.5", async () => 200)
    expect(cap.visible()).toBe(false)
  })
})

describe("session signals", () => {
  test("files, failing loop and tool errors", () => {
    const s = new SessionSignals()
    s.toolDone("a", "read", { filePath: "/x" }, {})
    s.toolDone("a", "edit", { filePath: "/y" }, {})
    s.toolDone("a", "read", { filePath: "/x" }, {})
    s.toolDone("a", "bash", {}, { exit: 1 })
    s.toolDone("a", "bash", {}, { exit: 2 })
    s.toolError("a")
    expect(s.snapshot("a")).toEqual({ filesTouched: 2, failingLoop: 2, toolErrors: 1 })
    s.toolDone("a", "bash", {}, { exit: 0 })
    expect(s.snapshot("a").failingLoop).toBe(0)
    expect(s.snapshot("other")).toEqual({ filesTouched: 0, failingLoop: 0, toolErrors: 0 })
    s.forget("a")
    expect(s.snapshot("a").filesTouched).toBe(0)
  })
})
