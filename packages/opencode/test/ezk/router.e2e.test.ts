import { afterEach, describe, expect, test } from "bun:test"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const STD = ["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "minimax-m3.1-flash", "default-model", "fast-model"]

let gw: ReturnType<typeof startMockGateway> | undefined
let srv: Server | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

async function boot(script: Record<string, any[]> = {}, models: string[] = STD, cfg?: Record<string, unknown>) {
  gw = startMockGateway({ models: { [KEY]: models }, script })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, authFile: false, config: cfg })
  return { gw, srv }
}
const chatModels = () => gw!.requests.map((r) => r.model)
const HEAVY = "Refactor the whole repo to a new architecture across the codebase and update all callers"

describe("router e2e (real server, mock gateway)", () => {
  test("Auto picks light/heavy models from the key's list and records the route", async () => {
    const { srv } = await boot()
    const providers = await srv.api("GET", "/config/providers")
    const ids = Object.keys(providers.providers.find((p: any) => p.id === "ezkielyna").models)
    expect(ids).toContain("ezk-auto")
    const a = await newSession(srv)
    await prompt(srv, a.id, "rename foo to bar", "ezk-auto")
    expect(chatModels()).toEqual(["deepseek-v4.1-flash"])
    const b = await newSession(srv)
    await prompt(srv, b.id, HEAVY, "ezk-auto")
    expect(chatModels()[1]).toBe("deepseek-v4-pro-0813")
    const turns = await srv.api("GET", `/ezk/router/turns?sessionID=${b.id}`)
    expect(turns).toHaveLength(1)
    expect(turns[0].route).toMatchObject({ mode: "auto", tier: "heavy", model: "deepseek-v4-pro-0813" })
    // the virtual id never reaches the gateway
    expect(chatModels()).not.toContain("ezk-auto")
    // internal headers never leave the machine
    for (const r of gw!.requests) expect(Object.keys(r.headers).filter((h) => h.startsWith("x-ezk"))).toEqual([])
  }, 90_000)

  test("pinned model and gateway alias are never rerouted", async () => {
    const { srv } = await boot()
    const s = await newSession(srv)
    await prompt(srv, s.id, HEAVY, "minimax-m3.1-flash")
    await prompt(srv, s.id, HEAVY, "default-model")
    expect(chatModels()).toEqual(["minimax-m3.1-flash", "default-model"])
    const turns = await srv.api("GET", `/ezk/router/turns?sessionID=${s.id}`)
    expect(turns.map((t: any) => t.route.mode)).toEqual(["pinned", "alias"])
  }, 90_000)

  test("403 on the heavy model: switches once to the next model, shows why, breaker is open", async () => {
    const { srv } = await boot({ "deepseek-v4-pro-0813": [{ status: 403 }] })
    const s = await newSession(srv)
    await prompt(srv, s.id, HEAVY, "ezk-auto")
    expect(chatModels()).toEqual(["deepseek-v4-pro-0813", "deepseek-v4.1-flash"])
    const turns = await srv.api("GET", `/ezk/router/turns?sessionID=${s.id}`)
    expect(turns[0].route).toMatchObject({ model: "deepseek-v4.1-flash", fallbackFrom: "deepseek-v4-pro-0813" })
    expect(turns[0].route.fallbackReason).toContain("403")
    const st = await srv.api("GET", "/ezk/router/status")
    expect(st.breakers.map((b: any) => b.model)).toContain("deepseek-v4-pro-0813")
    // next heavy message does not even try the closed model (30 min breaker)
    await prompt(srv, s.id, HEAVY, "ezk-auto")
    expect(chatModels().filter((m) => m === "deepseek-v4-pro-0813")).toHaveLength(1)
  }, 90_000)

  test("404 and 503 sequences", async () => {
    const { srv } = await boot({
      "deepseek-v4-pro-0813": [{ status: 404 }],
      "deepseek-v4.1-flash": [{ status: 503, body: "upstream overloaded" }],
    })
    const s = await newSession(srv)
    await prompt(srv, s.id, HEAVY, "ezk-auto")
    // heavy: pro 404 -> flash 503 (second failure is surfaced to the SDK, whose own retry then runs the request again)
    const seq = chatModels()
    expect(seq.slice(0, 2)).toEqual(["deepseek-v4-pro-0813", "deepseek-v4.1-flash"])
    expect(seq).toEqual(["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "deepseek-v4.1-flash"]) // 3rd = SDK retry, rerouted
    const st = await srv.api("GET", "/ezk/router/status")
    expect(st.breakers.find((b: any) => b.model === "deepseek-v4-pro-0813").reason).toContain("404")
  }, 120_000)

  test("timeout (no first byte) falls back; the stalled request does not hang the turn", async () => {
    const { srv } = await boot({ "deepseek-v4-pro-0813": [{ hang: true }] }, STD, undefined)
    const s = await newSession(srv)
    const t0 = Date.now()
    await prompt(srv, s.id, HEAVY, "ezk-auto")
    expect(chatModels()).toEqual(["deepseek-v4-pro-0813", "deepseek-v4.1-flash"])
    expect(Date.now() - t0).toBeLessThan(60_000)
  }, 120_000)

  test("failing loop escalates a light turn to the heavy model mid-turn", async () => {
    const fail = { ok: true as const, tool: { name: "bash", args: { command: "exit 3", description: "fails" } } }
    const { srv } = await boot({ "deepseek-v4.1-flash": [fail, fail, fail] })
    const s = await newSession(srv, { permission: [{ permission: "bash", pattern: "*", action: "allow" }] })
    await prompt(srv, s.id, "fix the failing test", "ezk-auto", { agent: "build" })
    const seq = chatModels()
    expect(seq[0]).toBe("deepseek-v4.1-flash")
    expect(seq).toContain("deepseek-v4-pro-0813")
    const turns = await srv.api("GET", `/ezk/router/turns?sessionID=${s.id}`)
    expect(turns[0].route.escalatedFrom).toBe("deepseek-v4.1-flash")
  }, 120_000)

  test("Flash-plan key (no v4-pro): everything stays on Flash, no 403 probing", async () => {
    const { srv } = await boot({}, ["deepseek-v4.1-flash", "minimax-m3.1-flash"])
    const s = await newSession(srv)
    await prompt(srv, s.id, HEAVY, "ezk-auto")
    expect(chatModels()).toEqual(["deepseek-v4.1-flash"])
  }, 90_000)

  test("router off (EZK_FEATURES=-router): no virtual model, prompts untouched", async () => {
    gw = startMockGateway({ models: { [KEY]: STD } })
    srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "-router" } })
    const providers = await srv.api("GET", "/config/providers")
    const ids = Object.keys(providers.providers.find((p: any) => p.id === "ezkielyna").models)
    expect(ids).not.toContain("ezk-auto")
  }, 90_000)
})
