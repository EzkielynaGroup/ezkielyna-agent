import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_FLAGS, loadFlags } from "../../src/ezk/flags"
import { DEFAULT_POLICY, allowedFrom, chainFor, cheapestFor, loadPolicy, mergePolicy, reviewerFor } from "../../src/ezk/model-policy"
import { PriceBook, STATIC_PRICES, costUSD, estimateTurnUSD, loadPricing, parsePricing, perMtok } from "../../src/ezk/pricing"
import { RouterEngine } from "../../src/ezk/router/engine"
import { H_MESSAGE, H_SESSION, failureStatus, routedFetch } from "../../src/ezk/router/fetch"
import { LOG_KEEP, RouterLog } from "../../src/ezk/router/log"
import { RouteTurns } from "../../src/ezk/router/turns"
import { catalogProvider } from "../../src/ezkielyna"

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-test-"))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("flags", () => {
  test("defaults", () => {
    const f = loadFlags([dir], {})
    expect(f).toEqual(DEFAULT_FLAGS)
    expect(f.router.claude).toBe(false)
    expect(f.memory.enabled).toBe(true)
    expect(f.tools.boundedOutput).toBe(true)
    expect(f.tools.applyPatchEverywhere).toBe(false)
    expect(f.tools.editFixer).toBe(false)
    expect(f.safety.protectedPaths).toBe(true)
    expect(f.models.metadata).toBe(true)
    expect(f.models.vision).toBe(true)
  })
  test("reads the ezk key from ezkielyna.jsonc (comments, trailing commas) and project overrides global", () => {
    const g = path.join(dir, "g")
    const p = path.join(dir, "p")
    fs.mkdirSync(g)
    fs.mkdirSync(p)
    fs.writeFileSync(path.join(g, "ezkielyna.jsonc"), `{ // hi\n "ezk": { "router": { "capUSD": 3, "log": true, }, "memory": { "reviewEvery": 4 } } }`)
    fs.writeFileSync(path.join(p, "ezkielyna.json"), `{"ezk": {"router": {"capUSD": 2}}}`)
    const f = loadFlags([g, p], {})
    expect(f.router.capUSD).toBe(2)
    expect(f.router.log).toBe(true)
    expect(f.memory.reviewEvery).toBe(4)
  })
  test("garbage config falls back to defaults", () => {
    fs.writeFileSync(path.join(dir, "ezkielyna.json"), "{{{")
    expect(loadFlags([dir], {})).toEqual(DEFAULT_FLAGS)
    fs.writeFileSync(path.join(dir, "ezkielyna.json"), `{"ezk":{"router":{"capUSD":"x","enabled":3}}}`)
    expect(loadFlags([dir], {}).router.capUSD).toBe(1)
  })
  test("EZK_FEATURES kill switch", () => {
    const f = loadFlags([dir], { EZK_FEATURES: "-router, -memory, +router.log, -search,bogus,-nope.x" })
    expect(f.router.enabled).toBe(false)
    expect(f.memory.enabled).toBe(false)
    expect(f.search.enabled).toBe(false)
    expect(f.router.log).toBe(true)
  })
  test("exposes the Wave A opt-ins through EZK_FEATURES", () => {
    const f = loadFlags([dir], { EZK_FEATURES: "+tools.applyPatchEverywhere,+tools.editFixer,+models.metadata,+models.vision" })
    expect(f.tools.applyPatchEverywhere).toBe(true)
    expect(f.tools.editFixer).toBe(true)
    expect(f.models.metadata).toBe(true)
    expect(f.models.vision).toBe(true)
  })
})

describe("model-policy", () => {
  const ids = ["deepseek-v4.1-flash", "minimax-m3.1-flash", "default-model", "auto", "claude-opus-5.5"]
  test("allowed set and aliases come from the key's list only", () => {
    const a = allowedFrom(ids)
    expect(a.aliases).toEqual(["default-model", "auto"])
    expect(allowedFrom(["x"]).aliases).toEqual([])
  })
  test("chains are filtered by allowed and end with the gateway alias", () => {
    const a = allowedFrom(ids)
    expect(chainFor(DEFAULT_POLICY, "light", a)).toEqual(["deepseek-v4.1-flash", "minimax-m3.1-flash", "default-model", "auto"])
    expect(chainFor(DEFAULT_POLICY, "heavy", a, { pro: true })[0]).toBe("claude-opus-5.5")
    expect(chainFor(DEFAULT_POLICY, "heavy", a)).not.toContain("claude-opus-5.5")
  })
  test("cheapest and reviewer models", () => {
    expect(cheapestFor(DEFAULT_POLICY, allowedFrom(ids))).toBe("deepseek-v4.1-flash")
    expect(cheapestFor(DEFAULT_POLICY, allowedFrom(["fast-model"]))).toBe("fast-model")
    expect(cheapestFor(DEFAULT_POLICY, allowedFrom(["zzz"]))).toBeUndefined()
    expect(reviewerFor(DEFAULT_POLICY, allowedFrom(["minimax-m3.1-flash"]))).toBe("minimax-m3.1-flash")
  })
  test("overlay validates ids and ignores garbage", () => {
    const m = mergePolicy(DEFAULT_POLICY, { chains: { light: ["a-1", "b.2"], heavy: ["bad id!"] }, flash: "no" })
    expect(m.chains.light).toEqual(["a-1", "b.2"])
    expect(m.chains.heavy).toEqual(DEFAULT_POLICY.chains.heavy)
    expect(m.flash).toEqual(DEFAULT_POLICY.flash)
    expect(mergePolicy(DEFAULT_POLICY, null)).toBe(DEFAULT_POLICY)
  })
  test("model metadata is validated, merged, and mapped into the provider catalog", () => {
    const policy = mergePolicy(DEFAULT_POLICY, {
      groupRatio: { free: 0.1, premium: 1.5, invalid: -1 },
      models: {
        "sample-model": {
          context: 128_000,
          agentContext: 64_000,
          maxOutput: 8_000,
          inputPrice: 0.25,
          outputPrice: 0.75,
          vision: true,
          reasoning: true,
          effort: true,
          groups: ["default", "member", "not a group"],
        },
        invalid: { agentContext: -1, maxOutput: Number.NaN, vision: "yes", reasoning: "yes", effort: 1 },
      },
    })
    expect(policy.models["sample-model"]).toEqual({
      agentContext: 64_000,
      maxOutput: 8_000,
      vision: true,
      reasoning: true,
      effort: true,
      groups: ["default", "member"],
    })
    expect(policy.models.invalid).toBeUndefined()
    expect(policy.groupRatio).toEqual({ free: 0.1, premium: 1.5 })
    const prices = { "sample-model": { ratio: 0.1, completion: 2, cache: 0.5, groupRatio: 1 } }
    const entry = catalogProvider(
      ["sample-model"],
      { ...policy.models, "sample-model": { ...policy.models["sample-model"], groupRatio: policy.groupRatio } },
      prices,
    ).models["sample-model"]!
    expect(entry.limit).toEqual({ context: 64_000, input: 64_000, output: 8_000 })
    expect(entry.cost).toEqual({ input: 0.2, output: 0.4, cache_read: 0.1 })
    expect(entry.groups).toEqual(["default", "member"])
    expect(entry.groupRatio).toEqual({ free: 0.1, premium: 1.5 })
    expect(entry.modalities?.input).toEqual(["text", "image", "pdf"])
    expect(entry.reasoning_options).toEqual([{ type: "effort", values: ["low", "medium", "high"] }])
    const fallback = catalogProvider(["fallback-model"]).models["fallback-model"]!
    expect(fallback.limit).toEqual({ context: 128_000, input: 100_000, output: 16_384 })
    expect(fallback.cost).toEqual({ input: 0, output: 0 })
    expect(fallback.modalities?.input).toEqual(["text"])
    const toggle = catalogProvider(["toggle-model"], { "toggle-model": { reasoning: true } }).models["toggle-model"]!
    expect(toggle.reasoning_options).toEqual([{ type: "toggle" }])
  })
  test("loadPolicy: local file, remote doc with cache, offline = defaults", async () => {
    fs.mkdirSync(path.join(dir, "ezk"))
    fs.writeFileSync(path.join(dir, "ezk", "model-policy.json"), JSON.stringify({ review: ["mine"] }))
    let calls = 0
    const f = (async () => {
      calls++
      return new Response(JSON.stringify({ chains: { light: ["remote-light"] } }))
    }) as unknown as typeof fetch
    const p1 = await loadPolicy({ configDir: dir, cacheDir: dir, policyURL: "http://x/policy", fetch: f })
    expect(p1.chains.light).toEqual(["remote-light"])
    expect(p1.review).toEqual(["mine"])
    await loadPolicy({ configDir: dir, cacheDir: dir, policyURL: "http://x/policy", fetch: f })
    expect(calls).toBe(1) // cached
    const off = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    const p2 = await loadPolicy({ configDir: path.join(dir, "none"), cacheDir: path.join(dir, "c2"), policyURL: "http://x", fetch: off })
    expect(p2).toEqual(DEFAULT_POLICY)
  })
})

describe("pricing", () => {
  const body = {
    group_ratio: { default: 1, premium: 1.5, free: 0.1 },
    data: [
      { model_name: "claude-opus-5.5", model_ratio: 0.151875, completion_ratio: 5, cache_ratio: 0.25, enable_groups: ["premium"] },
      { model_name: "deepseek-v4.1-flash", model_ratio: 0.001875, completion_ratio: 5.666667, cache_ratio: 0.25, enable_groups: ["default", "flash100"] },
      { model_name: "broken" },
    ],
  }
  test("parse and per-Mtok math match the research numbers", () => {
    const t = parsePricing(body)
    expect(Object.keys(t).sort()).toEqual(["claude-opus-5.5", "deepseek-v4.1-flash"])
    const o = perMtok(t["claude-opus-5.5"]!)
    expect(o.input).toBeCloseTo(0.4556, 3)
    expect(o.output).toBeCloseTo(2.278, 2)
    expect(perMtok(t["deepseek-v4.1-flash"]!).input).toBeCloseTo(0.00375, 5)
    expect(parsePricing("nope")).toEqual({})
  })
  test("costUSD and estimate", () => {
    const p = STATIC_PRICES["deepseek-v4.1-flash"]!
    const usd = costUSD(p, { input: 1_000_000, output: 100_000, cache: { read: 1_000_000, write: 0 } })
    expect(usd).toBeCloseTo(0.00375 + 0.00375 * 0.25 + 0.1 * 0.00375 * 5.666667, 5)
    expect(costUSD(undefined, { input: 1, output: 1 })).toBe(0)
    expect(estimateTurnUSD(p, 20_000)).toBeGreaterThan(0)
    expect(estimateTurnUSD(STATIC_PRICES["claude-opus-5.5"]!, 20000)).toBeGreaterThan(estimateTurnUSD(STATIC_PRICES["claude-sonnet-5.5"]!, 20000))
  })
  test("loadPricing caches for an hour and survives errors", async () => {
    let calls = 0
    const f = (async (u: any) => {
      calls++
      expect(String(u)).toBe("http://gw.test/api/pricing")
      return new Response(JSON.stringify(body))
    }) as unknown as typeof fetch
    const t1 = await loadPricing({ baseURL: "http://gw.test/v1", cacheDir: dir, fetch: f, now: 1000 })
    const t2 = await loadPricing({ baseURL: "http://gw.test/v1", cacheDir: dir, fetch: f, now: 2000 })
    expect(t1).toEqual(t2)
    expect(calls).toBe(1)
    await loadPricing({ baseURL: "http://gw.test/v1", cacheDir: dir, fetch: f, now: 1000 + 3600_001 })
    expect(calls).toBe(2)
    const bad = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch
    expect(await loadPricing({ baseURL: "http://gw.test/v1", cacheDir: path.join(dir, "other"), fetch: bad })).toEqual({})
    const book = new PriceBook()
    book.set(t1)
    expect(book.get("claude-opus-5.5")?.groupRatio).toBe(1.5)
    expect(book.get("default-model")).toBeDefined() // static fallback stays
  })
})

describe("log and turns", () => {
  test("log is off by default, rotates, mode 0600, wipe removes everything", () => {
    const off = new RouterLog(dir)
    off.write({ ts: 1, session: "s", model: "m", reason: "r" })
    expect(fs.existsSync(off.path)).toBe(false)
    const log = new RouterLog(dir, { enabled: true, maxBytes: 200 })
    for (let i = 0; i < 40; i++) log.write({ ts: i, session: "s", model: "m", reason: "x".repeat(30), prompt: "secret prompt" })
    expect(fs.existsSync(log.path)).toBe(true)
    expect(fs.statSync(log.path).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(`${log.path}.1`)).toBe(true)
    expect(fs.existsSync(`${log.path}.${LOG_KEEP + 1}`)).toBe(false)
    expect(fs.readFileSync(log.path, "utf8")).not.toContain("secret prompt")
    log.wipe()
    expect(fs.readdirSync(path.join(dir, "ezk"))).toEqual([])
  })
  test("prompt text only with logPrompts", () => {
    const log = new RouterLog(dir, { enabled: true, prompts: true })
    log.write({ ts: 1, session: "s", model: "m", reason: "r", prompt: "hello" })
    expect(fs.readFileSync(log.path, "utf8")).toContain("hello")
  })
  test("turns persist, last record wins, update merges, wipe", () => {
    const t = new RouteTurns(dir)
    t.set("s", "m1", { mode: "auto", model: "a", reason: "r", at: 1 })
    t.update("m1", { model: "b", fallbackFrom: "a" })
    const t2 = new RouteTurns(dir)
    expect(t2.get("m1")?.route.model).toBe("b")
    expect(t2.forSession("s").length).toBe(1)
    expect(t2.forSession("zzz")).toEqual([])
    expect(fs.statSync(path.join(dir, "ezk", "route-turns.jsonl")).mode & 0o777).toBe(0o600)
    t2.wipe()
    expect(new RouteTurns(dir).get("m1")).toBeUndefined()
  })
})

describe("routed fetch", () => {
  const BASE = "http://gw.test/v1"
  const json = (model: string) => ({ model, messages: [] })
  const post = (f: typeof fetch, model: string, headers: Record<string, string> = { [H_SESSION]: "s1", [H_MESSAGE]: "u1" }, signal?: AbortSignal) =>
    f(`${BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(json(model)), signal })
  const setup = (script: Record<string, (Response | "hang" | "throw")[]>, ids = ["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "minimax-m3.1-flash"]) => {
    const engine = new RouterEngine({ policy: DEFAULT_POLICY, prices: new PriceBook(), flags: DEFAULT_FLAGS.router })
    engine.setAllowed(ids)
    const seen: { model: string; headers: Headers }[] = []
    const base = (async (_u: any, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      seen.push({ model: body.model, headers: new Headers(init.headers) })
      const next = script[body.model]?.shift() ?? new Response("{}", { status: 200 })
      if (next === "throw") throw new TypeError("fetch failed")
      if (next === "hang") await new Promise((_, rej) => init.signal?.addEventListener("abort", () => rej(init.signal!.reason)))
      return next as Response
    }) as unknown as typeof fetch
    const switches: any[] = []
    const f = routedFetch({ engine, baseURL: BASE, base, firstByteMs: 60, onSwitch: (e) => switches.push(e) })
    engine.decide("s1", "u1", { prompt: "Refactor the whole repo to a new architecture across the codebase" })
    return { f, engine, seen, switches }
  }

  test("403 -> next model, once, breaker opens 30 min, internal headers stripped", async () => {
    const { f, engine, seen, switches } = setup({ "deepseek-v4-pro-0813": [new Response("denied", { status: 403 })] })
    const res = await post(f, "deepseek-v4-pro-0813")
    expect(res.status).toBe(200)
    expect(seen.map((s) => s.model)).toEqual(["deepseek-v4-pro-0813", "deepseek-v4.1-flash"])
    expect(switches).toHaveLength(1)
    expect(switches[0]).toMatchObject({ from: "deepseek-v4-pro-0813", to: "deepseek-v4.1-flash", status: 403, messageID: "u1" })
    expect(engine.breaker.isOpen("deepseek-v4-pro-0813")).toBe(true)
    for (const s of seen) {
      expect(s.headers.get(H_SESSION)).toBeNull()
      expect(s.headers.get(H_MESSAGE)).toBeNull()
    }
    expect(engine.session("s1").lastModel).toBe("deepseek-v4.1-flash")
  })
  test("404 and gateway 'no available channel' 503 count as closed models", async () => {
    const a = setup({ "deepseek-v4-pro-0813": [new Response("nf", { status: 404 })] })
    await post(a.f, "deepseek-v4-pro-0813")
    expect(a.engine.breaker.isOpen("deepseek-v4-pro-0813")).toBe(true)
    const b = setup({ "deepseek-v4-pro-0813": [new Response("No available channel for model", { status: 503 })] })
    await post(b.f, "deepseek-v4-pro-0813")
    expect(b.engine.breaker.isOpen("deepseek-v4-pro-0813")).toBe(true)
    expect(failureStatus(503, "overloaded")).toBe(503)
    expect(failureStatus(200, "")).toBeUndefined()
    expect(failureStatus(400, "bad json")).toBeUndefined()
    expect(failureStatus(400, "model_not_found")).toBe(404)
  })
  test("plain 503: switches once; the breaker needs 2 strikes", async () => {
    const { f, engine, switches } = setup({ "deepseek-v4-pro-0813": [new Response("x", { status: 503 })] })
    const res = await post(f, "deepseek-v4-pro-0813")
    expect(res.status).toBe(200)
    expect(switches).toHaveLength(1)
    expect(engine.breaker.isOpen("deepseek-v4-pro-0813")).toBe(false)
  })
  test("timeout (no first byte) -> next model", async () => {
    const { f, seen, switches } = setup({ "deepseek-v4-pro-0813": ["hang"] })
    const t0 = performance.now()
    const res = await post(f, "deepseek-v4-pro-0813")
    expect(res.status).toBe(200)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(seen.map((s) => s.model)[1]).toBe("deepseek-v4.1-flash")
    expect(switches[0].status).toBe(0)
    expect(switches[0].reason).toContain("timeout")
  })
  test("network error -> next model", async () => {
    const { f, switches } = setup({ "deepseek-v4-pro-0813": ["throw"] })
    expect((await post(f, "deepseek-v4-pro-0813")).status).toBe(200)
    expect(switches).toHaveLength(1)
  })
  test("second failure is returned to the caller (only one switch per request)", async () => {
    const { f, seen } = setup({
      "deepseek-v4-pro-0813": [new Response("x", { status: 403 })],
      "deepseek-v4.1-flash": [new Response("y", { status: 403 })],
    })
    const res = await post(f, "deepseek-v4-pro-0813")
    expect(res.status).toBe(403)
    expect(seen).toHaveLength(2)
  })
  test("a retry that still names a model whose breaker is open is rerouted without trying it", async () => {
    const { f, engine, seen } = setup({})
    engine.breaker.failure("deepseek-v4-pro-0813", 403)
    const res = await post(f, "deepseek-v4-pro-0813")
    expect(res.status).toBe(200)
    expect(seen.map((s) => s.model)).toEqual(["deepseek-v4.1-flash"])
  })
  test("pinned requests (no session header) are never rerouted but feed the breaker", async () => {
    const { f, engine, seen } = setup({ "deepseek-v4-pro-0813": [new Response("denied", { status: 403 })] })
    const res = await post(f, "deepseek-v4-pro-0813", {})
    expect(res.status).toBe(403)
    expect(seen).toHaveLength(1)
    expect(engine.breaker.isOpen("deepseek-v4-pro-0813")).toBe(true)
  })
  test("success closes the breaker; user abort is not a failure", async () => {
    const { f, engine } = setup({})
    engine.breaker.failure("deepseek-v4-pro-0813", 503)
    await post(f, "deepseek-v4-pro-0813")
    engine.breaker.failure("deepseek-v4-pro-0813", 503)
    expect(engine.breaker.isOpen("deepseek-v4-pro-0813")).toBe(false) // strikes were cleared by the success
    const slow = setup({ "deepseek-v4-pro-0813": ["hang"] })
    const ac = new AbortController()
    const p = post(slow.f, "deepseek-v4-pro-0813", undefined, ac.signal)
    ac.abort(new Error("user"))
    await expect(p).rejects.toThrow()
    expect(slow.switches).toHaveLength(0)
  })
  test("non-gateway and non-chat urls pass through untouched", async () => {
    const engine = new RouterEngine({ policy: DEFAULT_POLICY, prices: new PriceBook(), flags: DEFAULT_FLAGS.router })
    const calls: any[] = []
    const base = (async (u: any, init?: RequestInit) => {
      calls.push([String(u), init])
      return new Response("ok")
    }) as unknown as typeof fetch
    const f = routedFetch({ engine, baseURL: BASE, base })
    const init = { method: "POST", body: "{}", headers: { [H_SESSION]: "keep" } }
    await f("http://other.test/x", init)
    await f(`${BASE}/models`)
    expect(calls[0][1]).toBe(init)
    expect(calls[1][1]).toBeUndefined()
  })
})
