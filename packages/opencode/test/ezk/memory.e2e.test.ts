import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const MODELS = ["deepseek-v4.1-flash", "minimax-m3.1-flash", "deepseek-v4-pro-0813"]
let gw: ReturnType<typeof startMockGateway> | undefined
let srv: Server | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

const memDir = (s: Server) => path.join(s.dirs.config, "ezkielyna", "memory")
const seedMemory = (dirs: Server["dirs"]) => {
  const d = path.join(dirs.config, "ezkielyna", "memory")
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, "USER.md"), "Speaks Indonesian\n§\nPrefers short answers\n")
  fs.writeFileSync(path.join(d, "MEMORY.md"), "Uses bun 1.3.14 for tests\n")
}

async function boot(opts: { script?: Record<string, any[]>; seed?: boolean; config?: Record<string, unknown>; env?: Record<string, string> } = {}) {
  gw = startMockGateway({ models: { [KEY]: MODELS }, script: opts.script })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, config: opts.config, env: opts.env, seed: opts.seed ? seedMemory : undefined })
  return { gw, srv }
}
const userTurns = () => gw!.requests.filter((r) => !/You maintain two short notes/.test(r.system))
const waitFor = async (cond: () => boolean, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await Bun.sleep(150)
  }
  return false
}

describe("memory e2e", () => {
  test("frozen block: injected at session start, not changed mid-session, new session sees updates", async () => {
    const { srv } = await boot({ seed: true, config: { ezk: { memory: { review: false } } } })
    const a = await newSession(srv)
    await prompt(srv, a.id, "hi", "minimax-m3.1-flash")
    const first = userTurns()[0]!
    expect(first.system).toContain("<memory>")
    expect(first.system).toContain("Speaks Indonesian")
    expect(first.system).toContain("Uses bun 1.3.14 for tests")
    // change memory on disk mid-session
    const r = await srv.api("POST", "/ezk/memory/op", { action: "add", store: "user", text: "Likes tea" })
    expect(r.ok).toBe(true)
    await prompt(srv, a.id, "again", "minimax-m3.1-flash")
    const second = userTurns()[1]!
    expect(second.system).toBe(first.system) // byte-identical: prompt cache stays valid
    expect(second.system).not.toContain("Likes tea")
    const b = await newSession(srv)
    await prompt(srv, b.id, "hello", "minimax-m3.1-flash")
    expect(userTurns()[2]!.system).toContain("Likes tea")
  }, 90_000)

  test("memory tool saves, refuses secrets, files are 0600", async () => {
    const save = { ok: true as const, tool: { name: "memory", args: { action: "add", store: "user", text: "Works in Jakarta timezone" } } }
    const leak = { ok: true as const, tool: { name: "memory", args: { action: "add", store: "memory", text: "my key is sk-" + "abcdefghijklmnopqrstuvwxyz123456" } } }
    const { srv } = await boot({ script: { "minimax-m3.1-flash": [save, leak, { ok: true, text: "done" }] }, config: { ezk: { memory: { review: false } } } })
    const s = await newSession(srv, { permission: [{ permission: "ezk_memory", pattern: "*", action: "allow" }] })
    await prompt(srv, s.id, "remember I work in Jakarta time", "minimax-m3.1-flash")
    expect(fs.readFileSync(path.join(memDir(srv), "USER.md"), "utf8")).toContain("Works in Jakarta timezone")
    expect(fs.statSync(path.join(memDir(srv), "USER.md")).mode & 0o777).toBe(0o600)
    expect(fs.existsSync(path.join(memDir(srv), "MEMORY.md"))).toBe(false)
    const last = JSON.stringify(userTurns().at(-1)!.body.messages)
    expect(last).toContain("Not saved: looks like a secret")
    const st = await srv.api("GET", "/ezk/memory")
    expect(st.user.entries).toEqual(["Works in Jakarta timezone"])
  }, 90_000)

  test("private session: no block, tool refuses", async () => {
    const save = { ok: true as const, tool: { name: "memory", args: { action: "add", store: "user", text: "should not be saved" } } }
    const { srv } = await boot({ seed: true, script: { "minimax-m3.1-flash": [save] }, config: { ezk: { memory: { review: false } } } })
    const s = await newSession(srv)
    const st = await srv.api("POST", "/ezk/memory/private", { sessionID: s.id, on: true })
    expect(st.private).toBe(true)
    await prompt(srv, s.id, "secret chat", "minimax-m3.1-flash")
    expect(userTurns()[0]!.system).not.toContain("<memory>")
    expect(fs.readFileSync(path.join(memDir(srv), "USER.md"), "utf8")).not.toContain("should not be saved")
    expect(JSON.stringify(userTurns().at(-1)!.body.messages)).toContain("Private session")
  }, 90_000)

  test("wipe route erases everything and confirm is required", async () => {
    const { srv } = await boot({ seed: true })
    await expect(srv.api("POST", "/ezk/memory/wipe", {})).rejects.toThrow("400")
    expect(fs.existsSync(path.join(memDir(srv), "USER.md"))).toBe(true)
    const report = await srv.api("POST", "/ezk/memory/wipe", { confirm: true })
    expect(report.memoryFiles).toBeGreaterThanOrEqual(2)
    expect(fs.existsSync(memDir(srv))).toBe(false)
    const st = await srv.api("GET", "/ezk/memory")
    expect(st.user.entries).toEqual([])
  }, 90_000)

  test("reviewer: Flash call after the turn applies ops; secrets are rejected; only the gateway is contacted", async () => {
    const ops = JSON.stringify({
      ops: [
        { op: "add", store: "user", text: "Prefers Indonesian replies" },
        { op: "add", store: "memory", text: "deploy token is sk-" + "abcdefghijklmnopqrstuvwxyz123456" },
      ],
    })
    const { gw, srv } = await boot({ script: { "deepseek-v4.1-flash": [{ ok: true, text: ops }] }, config: { ezk: { memory: { reviewEvery: 1 } } } })
    const s = await newSession(srv)
    await prompt(srv, s.id, "tolong ingat saya suka jawaban bahasa Indonesia", "minimax-m3.1-flash")
    expect(gw.requests.some((r) => /You maintain two short notes/.test(r.system))).toBe(false)
    await srv.api("POST", "/ezk/memory/notice", {}) // user has seen and accepted the first-use notice
    await prompt(srv, s.id, "ingat juga saya suka jawaban ringkas", "minimax-m3.1-flash")
    expect(await waitFor(() => gw.requests.some((r) => /You maintain two short notes/.test(r.system)))).toBe(true)
    const review = gw.requests.find((r) => /You maintain two short notes/.test(r.system))!
    expect(review.model).toBe("deepseek-v4.1-flash")
    expect(review.body.messages[1].content.length).toBeLessThanOrEqual(6000)
    expect(await waitFor(() => fs.existsSync(path.join(memDir(srv), "USER.md")))).toBe(true)
    expect(fs.readFileSync(path.join(memDir(srv), "USER.md"), "utf8")).toContain("Prefers Indonesian replies")
    expect(fs.existsSync(path.join(memDir(srv), "MEMORY.md"))).toBe(false)
    const st = await srv.api("GET", "/ezk/memory")
    expect(st.lastReview.applied).toBe(1)
    expect(st.lastReview.rejected[0]).toContain("secret")
  }, 90_000)

  test("flag off (-memory): no tool, no block, no reviewer", async () => {
    const { gw, srv } = await boot({ seed: true, env: { EZK_FEATURES: "-memory" }, config: { ezk: { memory: { reviewEvery: 1 } } } })
    const s = await newSession(srv)
    await prompt(srv, s.id, "ingat ini", "minimax-m3.1-flash")
    await Bun.sleep(2500)
    const req = gw.requests[0]!
    expect(req.system).not.toContain("<memory>")
    expect(JSON.stringify(req.body.tools ?? [])).not.toContain('"memory"')
    expect(gw.requests.filter((r) => /You maintain two short notes/.test(r.system))).toHaveLength(0)
  }, 90_000)

  test("memory on with an empty store: system bytes identical to off, only the tool schema is added (token cost)", async () => {
    const run = async (env: Record<string, string>) => {
      gw = startMockGateway({ models: { [KEY]: MODELS } })
      srv = await startServer({ baseURL: gw.baseURL, key: KEY, env, config: { ezk: { memory: { review: false } } } })
      const s = await newSession(srv)
      await prompt(srv, s.id, "say hi", "minimax-m3.1-flash")
      const req = gw.requests[0]!
      const norm = (v: unknown) => JSON.stringify(v).split(srv!.dir).join("<TMP>")
      const out = { system: norm(req.body.messages.filter((m: any) => m.role === "system")), tools: req.body.tools ?? [] }
      await srv.stop()
      gw.stop()
      srv = gw = undefined
      return out
    }
    const off = await run({ EZK_FEATURES: "-memory,-search" })
    const on = await run({ EZK_FEATURES: "-search" })
    expect(on.system).toBe(off.system)
    const extra = on.tools.filter((t: any) => !off.tools.some((o: any) => o.function.name === t.function.name))
    expect(extra.map((t: any) => t.function.name)).toEqual(["memory"])
    const bytes = JSON.stringify(extra).length
    console.log(`memory tool schema: ${bytes} chars (~${Math.ceil(bytes / 4)} tokens)`)
    expect(Math.ceil(bytes / 4)).toBeLessThanOrEqual(300)
  }, 120_000)
})
