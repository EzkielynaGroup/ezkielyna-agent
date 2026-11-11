import { describe, expect, test } from "bun:test"
import type { ExecTaskView, UsageResponse } from "@opencode-ai/core/ezk/exec/contracts"
import type { StatusResponse } from "@opencode-ai/core/ezk/exec/status-contract"
import { statusClient } from "./status-client"
import { statusT } from "./status-strings"
import {
  buildChips,
  primaryChip,
  contextPct,
  formatPct,
  formatRuntime,
  formatTokens,
  formatUSD,
  runningCount,
  sayText,
  sessionIDFromPath,
  taskRows,
  usageView,
} from "./status-model"

const report = (over: Partial<Extract<UsageResponse, { enabled: true }>["report"]> = {}) =>
  ({
    steps: 2,
    tokens: { input: 3000, output: 400, cacheRead: 9000, cacheWrite: 0 },
    costUSD: 0.00123,
    cacheHitPct: 75,
    lastHitPct: 90,
    lastPromptTokens: 12_000,
    lastModelID: "deepseek-v4.1-flash",
    ...over,
  }) as Extract<UsageResponse, { enabled: true }>["report"]
const usage = (over: Partial<Extract<UsageResponse, { enabled: true }>> = {}): UsageResponse => ({
  enabled: true,
  statusline: false,
  report: report(),
  ...over,
})
const status = (over: Partial<StatusResponse> = {}): StatusResponse => ({
  sandbox: { active: false, kind: "none" },
  webSearch: false,
  exec: true,
  ...over,
})

describe("formatters", () => {
  test("cost: real small values are never shown as free", () => {
    expect(formatUSD(0)).toBe("$0.00")
    expect(formatUSD(undefined)).toBe("$0.00")
    expect(formatUSD(Number.NaN)).toBe("$0.00")
    expect(formatUSD(0.00001)).toBe("<$0.0001")
    expect(formatUSD(0.00123)).toBe("$0.0012")
    expect(formatUSD(0.5)).toBe("$0.50")
    expect(formatUSD(12.345)).toBe("$12.35")
  })
  test("tokens", () => {
    expect([0, 999, 1000, 1234, 15_000, 128_000, 1_500_000].map(formatTokens)).toEqual([
      "0",
      "999",
      "1k",
      "1.2k",
      "15k",
      "128k",
      "1.5M",
    ])
    expect(formatTokens(undefined)).toBe("0")
  })
  test("percent", () => {
    expect([0, 0.4, 1, 49.6, 100, 140, undefined].map(formatPct)).toEqual([
      "0%",
      "<1%",
      "1%",
      "50%",
      "100%",
      "100%",
      "0%",
    ])
  })
  test("runtime", () => {
    expect([0, 4_900, 60_000, 123_000, 3_900_000, -5].map(formatRuntime)).toEqual([
      "0s",
      "4s",
      "1m 00s",
      "2m 03s",
      "1h 05m",
      "0s",
    ])
  })
  test("context percent needs both numbers", () => {
    expect(contextPct(12_000, 120_000)).toBe(10)
    expect(contextPct(0, 120_000)).toBeUndefined()
    expect(contextPct(5, undefined)).toBeUndefined()
    expect(contextPct(500_000, 100_000)).toBe(100)
  })
  test("session id from the path", () => {
    expect(sessionIDFromPath("/abc/session/ses_1?x=1")).toBe("ses_1")
    expect(sessionIDFromPath("/abc")).toBeUndefined()
  })
})

describe("status pill", () => {
  test("selects the highest severity and leaves no pill when there is nothing to flag", () => {
    const chips = buildChips({
      trust: { trusted: false },
      status: status({ sandbox: { active: false, kind: "none" } }),
    })
    expect(primaryChip(chips)?.id).toBe("trust")
    expect(primaryChip([])).toBeUndefined()
  })

  test("does not show a status pill for trusted folders with sandbox enabled", () => {
    const chips = buildChips({
      trust: { trusted: true },
      status: status({ sandbox: { active: true, kind: "seatbelt" } }),
    })
    expect(chips).toEqual([])
    expect(primaryChip(chips)).toBeUndefined()
  })
})

describe("usageView reducer", () => {
  test("cost, tokens (prompt includes cached), cache and context against agentContext", () => {
    const v = usageView(
      usage({ contextPct: undefined }),
      status({
        agentContext: 120_000,
        price: { model: "m", groupRatio: 1.5, perMtok: { input: 1, output: 2, cachedInput: 0.1 } },
      }),
    )!
    expect(v.cost).toBe("$0.0012")
    expect(v.groupRatio).toBe(1.5)
    expect(v.tokensIn).toBe("12k")
    expect(v.tokensOut).toBe("400")
    expect(v.cachePct).toBe("75%")
    expect(v.context).toMatchObject({ label: "10%", window: "120k", high: false })
    expect(v.empty).toBe(false)
  })
  test("group ratio 1 is not shown; no cached tokens means no cache figure", () => {
    const v = usageView(
      usage({ report: report({ tokens: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 }, cacheHitPct: 0 }) }),
      status({ price: { model: "m", groupRatio: 1, perMtok: { input: 1, output: 2, cachedInput: 0.1 } } }),
    )!
    expect(v.groupRatio).toBeUndefined()
    expect(v.cachePct).toBeUndefined()
  })
  test("the server's measured context % wins and flags a nearly full window", () => {
    const v = usageView(usage({ contextPct: 85 }), status({ agentContext: 100_000 }))!
    expect(v.context).toMatchObject({ pct: 85, high: true })
  })
  test("no context figure without a window; diagnostics off gives nothing; no steps is empty", () => {
    expect(usageView(usage(), status())?.context).toBeUndefined()
    expect(usageView({ enabled: false, statusline: false }, status())).toBeUndefined()
    expect(usageView(undefined, undefined)).toBeUndefined()
    expect(usageView(usage({ report: report({ steps: 0 }) }), status())?.empty).toBe(true)
  })
})

describe("status alerts reducer", () => {
  const permission = (modes: boolean, effective = "acceptEdits") => ({
    flags: { modes },
    mode: { effective },
    modes: [
      { id: "acceptEdits", label: { en: "Auto-edit", id: "Edit otomatis" } },
      { id: "full", label: { en: "Full", id: "Penuh" } },
    ],
  })
  test("only escalates full access into an attention status", () => {
    expect(buildChips({ permission: permission(false) })).toEqual([])
    expect(buildChips({ permission: permission(true) })).toEqual([])
    expect(buildChips({ permission: permission(true, "full") })[0]!.tone).toBe("warn")
  })
  test("trust and disabled sandbox are presented as one attention pill", () => {
    const chips = buildChips({
      trust: { trusted: false },
      status: { sandbox: { active: false, kind: "none" }, webSearch: true },
    })
    expect(chips.map((c) => c.id)).toEqual(["trust", "sandbox"])
    expect(chips[0]).toMatchObject({ tone: "warn" })
    expect(sayText(chips[0]!.tip!, "id")).toContain("bertanya")
    expect(sayText(chips[1]!.text, "en")).toBe("Sandbox off")
  })
  test("sandbox inactive says off and unknown or safe facts make no chip", () => {
    const chips = buildChips({
      status: { sandbox: { active: false, kind: "none", reason: "bwrap unavailable" }, webSearch: false },
    })
    expect(chips.map((c) => sayText(c.text, "en"))).toEqual(["Sandbox off"])
    expect(sayText(chips[0]!.tip!, "id")).toContain("isolasi")
    expect(
      buildChips({ trust: { trusted: true }, status: status({ sandbox: { active: true, kind: "seatbelt" } }) }),
    ).toEqual([])
    expect(buildChips({})).toEqual([])
  })
})

describe("tasks reducer", () => {
  const t = (over: Partial<ExecTaskView>): ExecTaskView =>
    ({
      id: "a",
      owner: "s",
      command: "bun dev",
      cwd: "/p",
      pid: 1,
      backend: "pty",
      monitor: false,
      status: "running",
      startedAt: 1_000,
      lastAttendedAt: 1_000,
      bytes: 0,
      preview: "",
      ...over,
    }) as ExecTaskView
  test("running first, newest first, runtime from start (or end), last lines", () => {
    const rows = taskRows(
      [
        t({ id: "old-done", status: "exited", exitCode: 0, startedAt: 5_000, endedAt: 9_000, preview: "ok\n" }),
        t({ id: "run-1", startedAt: 2_000, preview: "l1\nl2\nl3\nl4\n" }),
        t({ id: "run-2", startedAt: 4_000 }),
      ],
      10_000,
    )
    expect(rows.map((r) => r.id)).toEqual(["run-2", "run-1", "old-done"])
    expect(rows[0]!.runtimeMs).toBe(6_000)
    expect(rows[1]!.lastLines).toEqual(["l2", "l3", "l4"])
    expect(rows[2]).toMatchObject({ running: false, runtimeMs: 4_000, lastLines: ["ok"], exitCode: 0 })
    expect(rows[0]!.lastLines).toEqual([])
    expect(runningCount(rows)).toBe(2)
  })
  test("empty list", () => expect(taskRows([], 1)).toEqual([]))
})

describe("strings and client", () => {
  test("EN and ID, with placeholders; unknown language falls back to EN", () => {
    expect(statusT("en")("usage.tokensValue", { input: "1k", output: "2" })).toBe("1k in · 2 out")
    expect(statusT("id-ID")("usage.tokensValue", { input: "1k", output: "2" })).toBe("1k masuk · 2 keluar")
    expect(statusT("fr")("chip.web")).toBe("Web search on")
    expect(statusT("id")("tasks.runtime", { time: "5s" })).toBe("Berjalan 5s")
  })
  test("both languages define every key", async () => {
    const src = await Bun.file(new URL("./status-strings.ts", import.meta.url)).text()
    const keys = [...src.matchAll(/^  "([a-z.A-Z]+)": /gm)].map((m) => m[1])
    expect(keys.length % 2).toBe(0)
    expect(new Set(keys).size).toBe(keys.length / 2)
  })
  test("client calls /ezk/account without receiving or sending a provider key", async () => {
    const seen: { url: string; auth: string | null }[] = []
    const f = (async (url: any, init: RequestInit) => {
      seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") })
      return new Response(JSON.stringify({ trusted: true }))
    }) as unknown as typeof fetch
    const api = statusClient({ url: "http://x/", username: "u", password: "p" }, f)
    await api.account()
    await api.usage("ses 1")
    await api.status("/p q", "ses_1", "deepseek-v4.1-flash")
    await api.trust("/p")
    expect(seen.map((s) => s.url)).toEqual([
      "http://x/ezk/account",
      "http://x/ezk/usage?sessionID=ses%201",
      "http://x/ezk/status?directory=%2Fp%20q&sessionID=ses_1&model=deepseek-v4.1-flash",
      "http://x/ezk/trust?directory=%2Fp",
    ])
    expect(seen.every((s) => s.auth?.startsWith("Basic "))).toBe(true)
    expect(seen.every((s) => s.auth?.startsWith("Bearer ") !== true)).toBe(true)
  })
})
