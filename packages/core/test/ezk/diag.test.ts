// U4: /context breakdown, /usage cache line and miss causes, status line, and doctor checks (the key is never printed).
import { describe, expect, test } from "bun:test"
import { RequestLog, contextBreakdown, size, sizeRequest } from "../../src/ezk/diag/context"
import { type Step, missCauseText, statusLine, usageReport } from "../../src/ezk/diag/usage"
import { type DoctorDeps, doctorExitCode, renderDoctor, runDoctor } from "../../src/ezk/diag/doctor"

describe("contextBreakdown", () => {
  const instructions = "Instructions from: /p/AGENTS.md\n" + "a".repeat(3_967)
  const memory = "<memory>" + "m".repeat(1_983) + "</memory>"
  const base = "You are the agent." + "s".repeat(7_982)
  const request = {
    system: [`${base}\n\n${memory}`, instructions],
    baseSystem: [base, instructions],
    tools: { bash: { description: "d".repeat(3_000), inputSchema: { type: "object" } } },
    messages: [{ role: "user", content: "x".repeat(10_000) }],
    memoryBlock: memory,
    modelID: "deepseek-v4.1-flash",
    window: 128_000,
  }
  test("splits system, instructions and memory, estimates at 4 chars per token", () => {
    const b = contextBreakdown(request)
    const by = Object.fromEntries(b.rows.map((r) => [r.part, r.tokens]))
    expect(by.instructions).toBe(1_000)
    expect(by.memory).toBe(500)
    expect(by.system).toBe(2_001)
    expect(by.tools).toBeGreaterThan(750)
    expect(by.messages).toBeGreaterThan(2_500)
    expect(b.source).toBe("estimated")
    expect(b.usedPct).toBeCloseTo((b.used / 128_000) * 100, 0)
  })
  test("scales to the gateway's measured prompt tokens", () => {
    const b = contextBreakdown(request, 20_000)
    expect(b.source).toBe("measured")
    expect(Math.abs(b.used - 20_000)).toBeLessThanOrEqual(5)
    expect(b.usedPct).toBeCloseTo(15.6, 0)
  })
  test("memory not in the sent system prompt is not counted", () => {
    const b = contextBreakdown({ ...request, system: [base, instructions] })
    expect(b.rows.find((r) => r.part === "memory")!.tokens).toBe(0)
  })
  test("size skips functions and cycles; the request log is bounded", () => {
    const a: any = { f: () => 1, x: 1 }
    a.self = a
    expect(size(a)).toBe('{"x":1}'.length)
    const log = new RequestLog(2)
    for (const id of ["a", "b", "c"]) log.record(id, request)
    expect(log.get("a")).toBeUndefined()
    expect(log.get("c")).toBe(request)
  })
  test("sizes replace the request: same breakdown, no message or tool objects kept", () => {
    const sizes = sizeRequest(request)
    expect(Object.values(sizes).some((v) => (v as unknown) === request.messages || (v as unknown) === request.tools)).toBe(false)
    expect(contextBreakdown(sizes)).toEqual(contextBreakdown(request))
    const log = new RequestLog(2)
    log.record("a", sizes)
    log.forget("a")
    expect(log.get("a")).toBeUndefined()
  })
})

describe("usageReport", () => {
  const step = (over: Partial<Step>, i = 0): Step => ({
    id: `m${i}`,
    modelID: "flash",
    providerID: "ezkielyna",
    tokens: { input: 1_000, output: 100, cache: { read: 9_000, write: 0 } },
    costUSD: 0.001,
    created: 1_000 + i * 10_000,
    completed: 2_000 + i * 10_000,
    ...over,
  })
  test("totals, cost and hit rate", () => {
    const r = usageReport([step({}, 0), step({}, 1)])
    expect(r.tokens).toEqual({ input: 2_000, output: 200, cacheRead: 18_000, cacheWrite: 0 })
    expect(r.costUSD).toBeCloseTo(0.002)
    expect(r.cacheHitPct).toBe(90)
    expect(r.lastPromptTokens).toBe(10_000)
    expect(r.missCause).toBeUndefined()
  })
  const miss = { tokens: { input: 10_000, output: 10, cache: { read: 0, write: 10_000 } } }
  test("miss causes", () => {
    expect(usageReport([step(miss)]).missCause).toBe("first-request")
    const none = { tokens: { input: 10_000, output: 10 } }
    expect(usageReport([step(none, 0), step(none, 1)]).missCause).toBe("not-reported")
    expect(usageReport([step({}, 0), step({ ...miss, modelID: "pro" }, 1)]).missCause).toBe("model-switch")
    expect(usageReport([step({ summary: true }, 0), step(miss, 1)]).missCause).toBe("compaction")
    expect(usageReport([step({}, 0), step({ ...miss, created: 2_000 + 6 * 60_000 }, 1)]).missCause).toBe("idle-expired")
    expect(usageReport([step({}, 0), step(miss, 1)], { prefixChanged: true }).missCause).toBe("prefix-changed")
    expect(missCauseText("idle-expired", "id")).toContain("5 menit")
  })
  test("status line", () => {
    expect(statusLine({ contextPct: 34.4, costUSD: 0.0123, cacheHitPct: 78.2, steps: 3 })).toBe("ctx 34% · $0.0123 · cache 78%")
    expect(statusLine({ costUSD: 0, cacheHitPct: 0, steps: 0 })).toBe("$0")
  })
})

describe("doctor", () => {
  const SECRET = "sk-" + "test-0123456789abcdef"
  const deps = (over: Partial<DoctorDeps> = {}): DoctorDeps => ({
    version: "1.2.3",
    key: () => ({ present: true, source: "saved" }),
    models: async () => ({ ok: true, status: 200, ms: 42, ids: ["deepseek-v4.1-flash", "minimax-m3.1-flash"] }),
    configSources: () => [
      { path: "/home/u/.config/ezkielyna/ezkielyna.json", exists: true },
      { path: "/p/ezkielyna.json", exists: false },
      { path: "/p/.ezkielyna/ezkielyna.jsonc", exists: true },
    ],
    trust: () => ({ dir: "/p", trusted: true }),
    diskFreeBytes: () => 50 * 1024 ** 3,
    dataDir: "/home/u/.local/share/ezkielyna",
    updateURL: "https://example.invalid/agent/update",
    ...over,
  })
  test("all good: exit 0, config files in merge order", async () => {
    const checks = await runDoctor(deps())
    expect(doctorExitCode(checks)).toBe(0)
    const text = renderDoctor(checks)
    expect(text).toContain("✓ Connection")
    expect(text).toContain("reachable (42 ms)")
    expect(text).toContain("2 available: deepseek-v4.1-flash, minimax-m3.1-flash")
    expect(text).toMatch(/1\. \/home\/u\/\.config\/ezkielyna\/ezkielyna\.json\n.*2\. \/p\/\.ezkielyna\/ezkielyna\.jsonc/)
    expect(text).not.toContain("/p/ezkielyna.json\n")
  })
  test("missing key fails and skips the connection check", async () => {
    let called = false
    const checks = await runDoctor(deps({ key: () => ({ present: false }), models: async () => ((called = true), { ok: true, ms: 1, ids: [] }) }))
    expect(called).toBe(false)
    expect(checks.find((c) => c.id === "key")!.status).toBe("fail")
    expect(checks.find((c) => c.id === "gateway")!.status).toBe("warn")
    expect(doctorExitCode(checks)).toBe(1)
  })
  test("refused key, unreachable gateway, low disk, untrusted folder, no updates (Indonesian)", async () => {
    const refused = await runDoctor(deps({ models: async () => ({ ok: false, status: 401, ms: 5, ids: [] }) }), "id")
    expect(refused.find((c) => c.id === "gateway")!.detail).toContain("kunci ditolak")
    const down = await runDoctor(deps({ models: async () => ({ ok: false, ms: 8000, ids: [], error: "timeout" }), diskFreeBytes: () => 200 * 1024 ** 2, trust: () => ({ dir: "/x", trusted: false }), updateURL: "" }))
    const by = Object.fromEntries(down.map((c) => [c.id, c]))
    expect(by.gateway!.detail).toContain("cannot be reached (timeout)")
    expect(by.disk!.status).toBe("warn")
    expect(by.trust!.detail).toContain("ezkielyna trust")
    expect(by.update!.status).toBe("warn")
  })
  test("never prints the key and never names a supplier", async () => {
    const text = renderDoctor(await runDoctor(deps({ key: () => ({ present: true, source: "env" }) }))) + renderDoctor(await runDoctor(deps(), "id"))
    expect(text).not.toContain(SECRET)
    expect(text).not.toMatch(/ExampleVendor|Partner/i)
  })
})
