// Cross-feature regression gates. All gateway traffic stays on a local mock server.
import fs from "node:fs"
import path from "node:path"
import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { ReviewGate } from "@opencode-ai/core/ezk/review-gate"
import { startMockGateway } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const MODELS = ["deepseek-v4-pro-0813", "deepseek-v4.1-flash", "minimax-m3.1-flash"]
let srv: Server | undefined
let gw: ReturnType<typeof startMockGateway> | undefined

afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

async function boot(input: { env?: Record<string, string>; seed?: (dirs: Server["dirs"]) => void } = {}) {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: input.env, seed: input.seed })
  return { srv, gw }
}

test("router plus memory keeps a frozen system block across routed turns", async () => {
  const { srv, gw } = await boot({
    seed(dirs) {
      const memory = path.join(dirs.config, "ezkielyna", "memory")
      fs.mkdirSync(memory, { recursive: true })
      fs.writeFileSync(path.join(memory, "MEMORY.md"), "- Keep router prompts cacheable.")
    },
  })
  const session = await newSession(srv)
  await prompt(srv, session.id, "explain a simple helper", "ezk-auto")
  await prompt(srv, session.id, "explain a simple helper", "ezk-auto")

  expect(gw.requests).toHaveLength(2)
  expect(gw.requests[0]!.model).toBe("deepseek-v4.1-flash")
  expect(gw.requests[0]!.system).toContain("Keep router prompts cacheable")
  expect(gw.requests[1]!.system).toBe(gw.requests[0]!.system)
}, 90_000)

test("router guard owns first-byte timeout when the watchdog is enabled", async () => {
  gw = startMockGateway({
    models: { [KEY]: MODELS },
    script: { "deepseek-v4-pro-0813": [{ hang: true }] },
  })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+watchdog,+loop.resilience" } })
  const session = await newSession(srv)
  const start = Date.now()
  await prompt(srv, session.id, "Refactor the whole repo architecture", "ezk-auto")

  expect(gw.requests.map((item) => item.model)).toEqual(["deepseek-v4-pro-0813", "deepseek-v4.1-flash"])
  expect(Date.now() - start).toBeLessThan(60_000)
}, 90_000)

test("memory and skill reviewers share one gateway call per turn", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  const gate = new ReviewGate()
  const callFlash = async () => {
    await fetch(`${gw!.baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "default-model", messages: [{ role: "user", content: "review" }], stream: false }),
    })
  }
  const runReviewer = async () => (gate.claim("session-1") ? (await callFlash(), true) : false)

  expect(await Promise.all([runReviewer(), runReviewer()])).toEqual([true, false])
  expect(gw.requests).toHaveLength(1)
  gate.clear("session-1")
  expect(await runReviewer()).toBe(true)
  expect(gw.requests).toHaveLength(2)
}, 15_000)

test("Telegram bridge stays dormant during ordinary server use", async () => {
  const { srv, gw } = await boot()
  const session = await newSession(srv)
  await prompt(srv, session.id, "say hello", "deepseek-v4.1-flash")

  expect(gw.requests).toHaveLength(1)
  expect(gw.requests[0]!.model).toBe("deepseek-v4.1-flash")
}, 45_000)

test("/hard is listed for TUI and Desktop only when enabled and a verify command exists", async () => {
  const { srv } = await boot({
    env: { EZK_FEATURES: "+loop.hard" },
    seed(dirs) {
      fs.writeFileSync(path.join(dirs.project, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    },
  })
  const commands = await srv.api<Array<{ name: string }>>("GET", "/command")
  expect(commands.some((command) => command.name === "hard")).toBe(true)
}, 30_000)

test("hard_mode is offered to the model only when enabled for a verifiable project", async () => {
  const { srv, gw } = await boot({
    env: { EZK_FEATURES: "+loop.hard" },
    seed(dirs) {
      fs.writeFileSync(path.join(dirs.project, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
    },
  })
  const session = await newSession(srv)
  await prompt(srv, session.id, "say hello", "deepseek-v4.1-flash")
  expect(JSON.stringify(gw.requests[0]!.body.tools)).toContain("hard_mode")
}, 45_000)

test("all feature kill switches preserve baseline prompt and tool bytes", async () => {
  const capture = async (features?: string) => {
    const { srv: server, gw: gateway } = await boot({ env: features ? { EZK_FEATURES: features } : {} })
    const session = await newSession(server)
    await prompt(server, session.id, "say hello", "deepseek-v4.1-flash")
    const request = gateway.requests[0]!
    const normalize = (value: unknown) => JSON.stringify(value).split(server.dir).join("<TMP>")
    const bytes = normalize([
      request.body.messages.filter((item: any) => item.role === "system"),
      request.body.tools,
    ])
    const digest = createHash("sha256").update(bytes).digest("hex")
    await server.stop()
    gateway.stop()
    srv = gw = undefined
    return { bytes, digest }
  }
  // v1.1 memory/search are intentionally disabled in the unextended ezkielyna prompt baseline.
  const baseline = await capture("-memory,-search")
  const off = await capture("-router,-memory,-search,-watchdog,-tolerant-edit,-mcp-defer,-skills,-loop.lead-worker,-loop.phase-reasoning,-loop.verification-gate,-loop.verify,-loop.plan,-loop.guard,-loop.resilience,-loop.history,-loop.hard")
  expect(off.bytes).toBe(baseline.bytes)
  expect(off.digest).toBe(baseline.digest)
}, 90_000)

test("lead/worker routing uses heavy until a plan artifact exists, then light", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+loop.lead-worker" } })
  gw.script["deepseek-v4-pro-0813"] = [
    { ok: true, tool: { name: "todowrite", args: { todos: [{ content: "Use the light chain for implementation.", status: "pending", priority: "high" }] } } },
    { ok: true, text: "Plan saved." },
  ]
  const session = await newSession(srv, { permission: [{ permission: "todowrite", pattern: "*", action: "allow" }] })
  await prompt(srv, session.id, "make a plan for a tiny change", "ezk-auto")
  await prompt(srv, session.id, "implement the plan", "ezk-auto")

  expect(gw.requests.map((request) => request.model)).toEqual([
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro-0813",
    "deepseek-v4.1-flash",
  ])
  const turns = await srv.api("GET", `/ezk/router/turns?sessionID=${session.id}`)
  expect(turns[1]!.route).toMatchObject({ tier: "light" })
  expect(turns[1]!.route.reason).toContain("execution phase after plan or todo")
}, 120_000)

test("@heavy, /pin, and /unpin control Auto routing at message boundaries", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+loop.lead-worker" } })
  const session = await newSession(srv)
  await prompt(srv, session.id, "@heavy start", "ezk-auto")
  await prompt(srv, session.id, "/pin keep this model", "ezk-auto")
  await prompt(srv, session.id, "rename a local variable", "ezk-auto")
  await prompt(srv, session.id, "/unpin resume routing", "ezk-auto")

  expect(gw.requests.map((request) => request.model)).toEqual([
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro-0813",
    "deepseek-v4.1-flash",
  ])
}, 120_000)

test("phase reasoning is safe when the selected model has no high/medium variants", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+loop.phase-reasoning" } })
  const session = await newSession(srv)
  await prompt(srv, session.id, "rename a local variable", "ezk-auto")
  expect(gw.requests).toHaveLength(1)
  expect(gw.requests[0]!.model).toBe("deepseek-v4.1-flash")
}, 90_000)

test("verification gate appends one reminder after edits without changing system bytes", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "+loop.lead-worker,+loop.verification-gate" } })
  gw.script["deepseek-v4-pro-0813"] = [
    { ok: true, tool: { name: "write", args: { filePath: path.join(srv.dirs.project, "edited.txt"), content: "done" } } },
    { ok: true, text: "Done." },
    { ok: true, text: "Verified the change." },
  ]
  const session = await newSession(srv, { permission: [
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: `${srv.dirs.project}/*`, action: "allow" },
  ] })
  await prompt(srv, session.id, "write a short note", "ezk-auto")

  expect(gw.requests).toHaveLength(3)
  expect(gw.requests.map((request) => request.model)).toEqual([
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro-0813",
    "deepseek-v4-pro-0813",
  ])
  const reminderRequest = gw.requests[2]!
  expect(JSON.stringify(reminderRequest.body.messages)).toContain(
    "verify against the original request: run tests/build or the project verify command, list evidence; if nothing can be run, say why",
  )
  expect(gw.requests[0]!.system).toBe(gw.requests[2]!.system)
  const turns = await srv.api("GET", `/ezk/router/turns?sessionID=${session.id}`)
  expect(turns).toHaveLength(2)
  expect(turns[1]!.route.model).toBe("deepseek-v4-pro-0813")
}, 120_000)

test("a stream cut after partial text is not retried: partial text kept, friendly error (ezk-netcut)", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "-router,-memory,-search,+loop.resilience", EZK_LANG: "id" } })
  gw.script["deepseek-v4.1-flash"] = [
    { partialFailure: "Partial response before the disconnect." },
    { ok: true, text: "Recovered." },
  ]
  const session = await newSession(srv)
  const t0 = Date.now()
  await prompt(srv, session.id, "say hello", "deepseek-v4.1-flash")
  const elapsed = Date.now() - t0

  // A cut mid-stream cannot be resumed: exactly one request, no 30 s back-off, answer within ~15 s.
  expect(gw.requests.map((request) => request.model)).toEqual(["deepseek-v4.1-flash"])
  expect(elapsed).toBeLessThan(15_000)
  const result = await srv.api("GET", `/session/${session.id}/message`)
  const messages: any[] = result?.data ?? result ?? []
  const text = messages.flatMap((message) => message.parts ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
  expect(text).toContain("Partial response before the disconnect.")
  expect(text).not.toContain("Recovered.")
  const error = messages.map((message) => message.info?.error ?? message.error).find(Boolean)
  expect(error?.data?.message).toBe("Koneksi ke gateway terputus di tengah jawaban. Coba lagi.")
}, 90_000)

test("loop guard appends a reminder after three repeats of a two-call window", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "-router,-memory,-search,+loop.guard" } })
  gw.script["deepseek-v4.1-flash"] = Array.from({ length: 6 }, (_, index) => index % 2 === 0
    ? { ok: true, tool: { name: "read", args: { filePath: srv!.dirs.project } } }
    : { ok: true, tool: { name: "bash", args: { command: "pwd", description: "show working directory" } } })
  const session = await newSession(srv, { permission: [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "external_directory", pattern: `${srv.dirs.project}/*`, action: "allow" },
  ] })
  await prompt(srv, session.id, "inspect the project", "deepseek-v4.1-flash")

  expect(gw.requests).toHaveLength(7)
  expect(JSON.stringify(gw.requests[6]!.body.messages)).toContain("Step back: re-read the error and consider another approach.")
}, 120_000)

test("history repair sends an interrupt result before the next gateway request", async () => {
  gw = startMockGateway({ models: { [KEY]: MODELS } })
  srv = await startServer({ baseURL: gw.baseURL, key: KEY, env: { EZK_FEATURES: "-router,-memory,-search,+loop.history" } })
  gw.script["deepseek-v4.1-flash"] = [
    { ok: true, tool: { name: "bash", args: { command: "sleep 8", description: "wait" } } },
    { ok: true, text: "Resumed after the interrupted call." },
  ]
  const session = await newSession(srv, { permission: [{ permission: "bash", pattern: "*", action: "allow" }] })
  const first = prompt(srv, session.id, "run a slow command", "deepseek-v4.1-flash").catch(() => undefined)
  const deadline = Date.now() + 10_000
  let running = false
  while (Date.now() < deadline) {
    const result = await srv.api("GET", `/session/${session.id}/message`)
    const messages: any[] = result?.data ?? result ?? []
    running = messages.some((message) => message.parts?.some((part: any) => part.type === "tool" && part.state?.status === "running"))
    if (running) break
    await Bun.sleep(100)
  }
  expect(running).toBe(true)
  await srv.api("POST", `/session/${session.id}/abort`)
  await first
  await prompt(srv, session.id, "continue", "deepseek-v4.1-flash")

  expect(gw.requests).toHaveLength(2)
  expect(JSON.stringify(gw.requests[1]!.body.messages)).toContain("[interrupted by user]")
}, 120_000)
