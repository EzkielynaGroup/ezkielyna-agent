// "All flags ON" interaction tests: shared boot + invariant helpers. Tests only: no product code is touched.
// Everything runs against the mock gateway on 127.0.0.1 with a fake key; nothing real is called or printed.
import fs from "node:fs"
import path from "node:path"
import { expect } from "bun:test"
import { startMockGateway, type Recorded, type Step } from "../../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "../harness"

export { newSession, prompt }
export type { Server, Step }
export const KEY = "test-key-not-real"
export const FLASH = "deepseek-v4.1-flash"
export const PRO = "deepseek-v4-pro-0813"
export const MINI = "minimax-m3.1-flash"
export const MODELS = [PRO, FLASH, MINI]

/** Every experimental flag of the v3 beta table (FLAGS-BETA.md section F). `hard mode` has no flag in the code (see report). */
export const ALL_FLAGS = [
  "modes", "rules", "hooks", "sandbox", "exec", "loop.leadWorker", "loop.phaseReasoning", "loop.verificationGate", "loop.guard",
  "loop.resilience", "loop.history", "loop.verify", "loop.plan", "compaction", "safety.classifier", "codesearch", "rewind",
  "planApproval", "subagents", "handoff", "review",
]
export const flagList = (flags: string[]) => flags.map((f) => `+${f}`).join(",")
// router/memory/search are default-ON core features: switched off so the scripted mock steps are the only model calls
export const QUIET = "-router,-memory,-search,-skills"
export const POWER_USER = ["modes", "rules", "exec", "loop.leadWorker", "loop.phaseReasoning", "loop.verificationGate", "loop.guard", "loop.resilience", "loop.history", "loop.verify", "loop.plan"]
export const SAFE = ["safety.classifier", "sandbox", "hooks", "modes"]

export interface Ctx {
  gw: ReturnType<typeof startMockGateway>
  srv: Server
}
let current: Ctx | undefined
export async function teardown() {
  await current?.srv.stop()
  current?.gw.stop()
  current = undefined
}

export function gitInit(dir: string) {
  const run = (...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  run("init", "-q")
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n")
  run("add", "-A")
  run("commit", "-qm", "init")
}

export async function boot(input: {
  flags: string
  script?: Record<string, Step[]>
  trusted?: boolean
  mode?: string
  settings?: Record<string, unknown>
  config?: Record<string, unknown>
  seed?: (d: Server["dirs"]) => void
  env?: Record<string, string>
}): Promise<Ctx> {
  const gw = startMockGateway({ models: { [KEY]: MODELS }, script: input.script ?? {} })
  const srv = await startServer({
    baseURL: gw.baseURL,
    key: KEY,
    config: input.config,
    env: { EZK_FEATURES: input.flags, EZK_TRUST_PROJECT: input.trusted === false ? "0" : "1", ...(input.mode ? { EZK_PERMISSION_MODE: input.mode } : {}), ...input.env },
    seed: (d) => {
      gitInit(d.project)
      if (input.trusted === false) fs.writeFileSync(path.join(d.config, "ezkielyna", "trusted-projects.json"), "[]")
      if (input.settings) {
        fs.mkdirSync(path.join(d.project, ".ezkielyna"), { recursive: true })
        fs.writeFileSync(path.join(d.project, ".ezkielyna", "settings.json"), JSON.stringify(input.settings))
      }
      input.seed?.(d)
    },
  })
  current = { gw, srv }
  return current
}

export const toolNames = (r: Recorded): string[] => (r.body.tools ?? []).map((t: any) => t.function?.name ?? t.name)
export const bodyText = (r: Recorded) => JSON.stringify(r.body.messages)
export const systemOf = (r: Recorded) => JSON.stringify(r.body.messages.filter((m: any) => m.role === "system"))

const contentText = (m: any): string => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p.text ?? "").join("\n") : "")
export const reminders = (m: any): string[] => [...contentText(m).matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)].map((x) => x[1]!.trim())

/** Requests of the main agent loop (same system prompt as the first request), excluding subagents and summaries. */
export function mainRequests(gw: Ctx["gw"]) {
  const first = gw.requests.find((r) => r.tools > 0)
  if (!first) return []
  const sys = systemOf(first)
  return gw.requests.filter((r) => r.tools > 0 && systemOf(r) === sys)
}

/** I1: no tool registered twice in any request. */
export function expectNoDuplicateTools(gw: Ctx["gw"]) {
  for (const r of gw.requests) {
    const names = toolNames(r)
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([])
  }
}

/** I2: no reminder repeated inside one message, and none repeated across the user messages of one request except the documented per-user-message mode reminder. */
export function expectNoDuplicateReminders(gw: Ctx["gw"]) {
  // main-loop and subagent requests only: the compaction summary input is one big message (see BUG-5 in the report)
  for (const r of gw.requests.filter((x) => x.tools > 0)) {
    for (const m of r.body.messages) {
      const list = reminders(m)
      const dup = list.filter((x, i) => list.indexOf(x) !== i)
      if (dup.length) console.log("DUPREMINDER request", gw.requests.indexOf(r), "role", m.role, "message#", r.body.messages.indexOf(m), "of", r.body.messages.length, JSON.stringify(m).slice(0, 600))
      expect(dup).toEqual([])
    }
  }
}

/** I3: the system prompt and the tool list never change between turns of the main loop (compaction aside, handled by callers). */
export function expectStablePrefix(gw: Ctx["gw"], opts: { allowToolChange?: boolean } = {}) {
  const reqs = mainRequests(gw)
  expect(reqs.length).toBeGreaterThan(1)
  for (const r of reqs.slice(1)) {
    expect(systemOf(r)).toBe(systemOf(reqs[0]!))
    if (!opts.allowToolChange) expect(toolNames(r)).toEqual(toolNames(reqs[0]!))
  }
}

/** I3b: each request's message list starts with the previous request's messages (append-only history). Returns the first break index or -1. */
export function firstPrefixBreak(gw: Ctx["gw"]) {
  const reqs = mainRequests(gw)
  for (let i = 1; i < reqs.length; i++) {
    const a = reqs[i - 1]!.body.messages
    const b = reqs[i]!.body.messages
    for (let j = 0; j < a.length; j++) if (JSON.stringify(a[j]) !== JSON.stringify(b[j])) return { request: i, message: j, role: a[j].role, before: JSON.stringify(a[j]).slice(0, 700), after: JSON.stringify(b[j]).slice(0, 700) }
  }
  return -1
}

/** I5: every assistant tool_call has a tool message with the same id, and no tool message is orphaned. */
export function expectToolCallsAnswered(gw: Ctx["gw"]) {
  for (const r of gw.requests) {
    const calls = new Set<string>()
    const answers = new Set<string>()
    for (const m of r.body.messages) {
      for (const c of m.tool_calls ?? []) calls.add(c.id)
      if (m.role === "tool") answers.add(m.tool_call_id)
    }
    expect([...calls].filter((c) => !answers.has(c))).toEqual([])
    expect([...answers].filter((a) => !calls.has(a))).toEqual([])
  }
}

/** Protected files that exist at the project root must be unchanged. */
export const sha = (file: string) => (fs.existsSync(file) ? new Bun.CryptoHasher("sha256").update(fs.readFileSync(file)).digest("hex") : "missing")

export async function messages(srv: Server, id: string) {
  const r = await srv.api("GET", `/session/${id}/message`)
  return (r?.data ?? r ?? []) as any[]
}
export const toolParts = (msgs: any[]) => msgs.flatMap((m) => m.parts ?? []).filter((p: any) => p.type === "tool")

/** Answer permission prompts while a prompt runs. `decide` returns once/reject per request; every request is recorded. */
export async function promptAnswering(s: Server, sessionID: string, text: string, model: string, decide: (req: any) => "once" | "reject" | "always" = () => "reject", extra: Record<string, unknown> = {}) {
  const asked: any[] = []
  const done = prompt(s, sessionID, text, model, extra).then(() => true)
  for (let i = 0; i < 600; i++) {
    if (await Promise.race([done, Bun.sleep(100).then(() => false)])) return asked
    for (const req of (await s.api<any[]>("GET", "/permission")) ?? []) {
      if (asked.some((a) => a.id === req.id)) continue
      asked.push(req)
      await s.api("POST", `/permission/${req.id}/reply`, { reply: decide(req) })
    }
  }
  throw new Error("prompt did not finish")
}

/** Does any process whose command line contains `marker` still run? (ps, no secrets involved) */
export function liveProcs(marker: string) {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="]).stdout.toString()
  return out.split("\n").filter((l) => l.includes(marker) && !l.includes("ps -axo"))
}
export async function waitGone(marker: string, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (liveProcs(marker).length === 0) return true
    await Bun.sleep(200)
  }
  return false
}

export const allowAll = (srv: Server) => [
  { permission: "edit", pattern: "*", action: "allow" },
  { permission: "bash", pattern: "*", action: "allow" },
  { permission: "todowrite", pattern: "*", action: "allow" },
  { permission: "external_directory", pattern: `${srv.dirs.project}/*`, action: "allow" },
]

/** I7: no unhandled rejection / uncaught exception reached the server log. */
export function expectCleanLogs(srv: Server) {
  const logs = srv.logs()
  expect(logs).not.toMatch(/unhandled(?:\s+promise)?\s+rejection|UnhandledPromiseRejection|uncaught exception|Uncaught/i)
}
