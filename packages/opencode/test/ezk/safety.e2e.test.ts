// Wave B safety e2e: the real `ezkielyna serve` against the mock gateway (no network, no real keys).
// Hooks: block an edit (PreToolUse exit 2), inject context (UserPromptSubmit), a Stop hook that forces "run tests".
// Modes: Edit otomatis writes without asking in a trusted folder; Rencana drops the edit tools; untrusted folders ask
// and ignore project hooks. Remembered rules: `Bash(echo *)` runs, `echo; rm` still asks.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { startMockGateway, type Step } from "../../../core/test/ezk/mock-gateway"
import { type Server, newSession, prompt, startServer } from "./harness"

const KEY = "test-key-not-real"
const MODEL = "deepseek-v4.1-flash"

let gw: ReturnType<typeof startMockGateway> | undefined
let srv: Server | undefined
afterEach(async () => {
  await srv?.stop()
  gw?.stop()
  srv = gw = undefined
})

async function boot(input: { script?: Step[]; features?: string; trusted?: boolean; mode?: string; settings?: Record<string, unknown>; config?: Record<string, unknown> }) {
  gw = startMockGateway({ models: { [KEY]: [MODEL, "default-model"] }, script: { [MODEL]: input.script ?? [] } })
  srv = await startServer({
    baseURL: gw.baseURL,
    key: KEY,
    config: input.config,
    // the test preload trusts every folder (EZK_TRUST_PROJECT=1); here trust comes from the real trusted-projects.json
    env: { EZK_TRUST_PROJECT: "0", EZK_FEATURES: input.features ?? "", ...(input.mode ? { EZK_PERMISSION_MODE: input.mode } : {}) },
    seed: (dirs) => {
      fs.writeFileSync(path.join(dirs.project, "README.md"), "# demo\n")
      if (input.trusted !== false) fs.writeFileSync(path.join(dirs.config, "ezkielyna", "trusted-projects.json"), JSON.stringify([fs.realpathSync(dirs.project)]))
      if (input.settings) {
        fs.mkdirSync(path.join(dirs.project, ".ezkielyna"), { recursive: true })
        fs.writeFileSync(path.join(dirs.project, ".ezkielyna", "settings.json"), JSON.stringify(input.settings))
      }
    },
  })
  return srv
}

/** Text of every message the gateway saw in request `i` (tool results included). */
const sent = (i: number) => JSON.stringify(gw!.requests[i]?.body.messages ?? [])
const toolNames = (i: number) => (gw!.requests[i]?.body.tools ?? []).map((t: any) => t.function?.name)

/** Send a prompt without waiting, answer permission prompts with `reply`, and return what was asked. */
async function promptAnswering(s: Server, sessionID: string, text: string, reply: "once" | "reject") {
  const asked: any[] = []
  const done = prompt(s, sessionID, text, MODEL).then(() => true)
  for (let i = 0; i < 200; i++) {
    const finished = await Promise.race([done, Bun.sleep(100).then(() => false)])
    if (finished) return asked
    for (const req of (await s.api<any[]>("GET", "/permission")) ?? []) {
      if (asked.some((a) => a.id === req.id)) continue
      asked.push(req)
      await s.api("POST", `/permission/${req.id}/reply`, { reply })
    }
  }
  throw new Error("prompt did not finish")
}

describe("hooks (E1)", () => {
  test("PreToolUse exit 2 blocks an edit and the model sees the reason", async () => {
    const s = await boot({
      features: "+hooks",
      script: [{ ok: true, tool: { name: "write", args: { filePath: "generated.ts", content: "x" } } }, { ok: true, text: "understood" }],
      settings: { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo 'generated files are read-only' >&2; exit 2" }] }] } },
    })
    const ses = await newSession(s)
    await prompt(s, ses.id, "create generated.ts", MODEL)
    expect(fs.existsSync(path.join(s.dirs.project, "generated.ts"))).toBe(false)
    expect(gw!.requests).toHaveLength(2)
    expect(sent(1)).toContain("generated files are read-only")
  }, 90_000)

  test("UserPromptSubmit stdout is added as context for the model", async () => {
    const s = await boot({
      features: "+hooks",
      settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'Ticket: ABC-123'" }] }] } },
    })
    const ses = await newSession(s)
    await prompt(s, ses.id, "fix the bug", MODEL)
    expect(sent(0)).toContain("Ticket: ABC-123")
    expect(sent(0)).toContain("fix the bug")
  }, 90_000)

  test("a Stop hook forces one more turn to run tests, then lets the agent stop", async () => {
    const marker = "stop-marker"
    const s = await boot({
      features: "+hooks",
      script: [{ ok: true, text: "done" }, { ok: true, text: "tests pass" }],
      settings: {
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: `if [ -f ${marker} ]; then exit 0; fi; touch ${marker}; echo '{"decision":"block","reason":"run tests before finishing"}'` }] }],
        },
      },
    })
    const ses = await newSession(s)
    await prompt(s, ses.id, "change the readme", MODEL)
    expect(gw!.requests).toHaveLength(2)
    expect(sent(1)).toContain("run tests before finishing")
    expect(fs.existsSync(path.join(s.dirs.project, marker))).toBe(true)
  }, 90_000)

  test("untrusted folder: project hooks are ignored", async () => {
    const s = await boot({
      features: "+hooks",
      trusted: false,
      settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'SHOULD-NOT-RUN'" }] }] } },
    })
    const ses = await newSession(s)
    await prompt(s, ses.id, "hello", MODEL)
    expect(sent(0)).not.toContain("SHOULD-NOT-RUN")
    const st = await s.api("GET", `/ezk/hooks?directory=${encodeURIComponent(s.dirs.project)}`)
    expect(st).toMatchObject({ enabled: true, trusted: false, skippedProjectHooks: 1, hooks: [] })
  }, 90_000)

  test("hooks flag off: nothing runs (default)", async () => {
    const s = await boot({ settings: { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'SHOULD-NOT-RUN'" }] }] } } })
    const ses = await newSession(s)
    await prompt(s, ses.id, "hello", MODEL)
    expect(sent(0)).not.toContain("SHOULD-NOT-RUN")
  }, 90_000)
})

describe("permission modes (S1)", () => {
  const write = (file: string): Step[] => [{ ok: true, tool: { name: "write", args: { filePath: file, content: "hello" } } }, { ok: true, text: "written" }]

  test("Edit otomatis (default when the flag is on): an edit inside a trusted project runs without asking", async () => {
    const s = await boot({ features: "+modes", script: write("notes.md") })
    const ses = await newSession(s)
    const asked = await promptAnswering(s, ses.id, "write notes", "reject")
    expect(asked).toEqual([])
    expect(fs.readFileSync(path.join(s.dirs.project, "notes.md"), "utf8")).toBe("hello")
    // the model is told about the mode in an appended reminder, not in the system prompt
    expect(sent(0)).toContain("Permission mode is now auto-edit")
    expect(gw!.requests[0]!.system).not.toContain("Permission mode")
  }, 90_000)

  test("Edit otomatis still asks for protected paths", async () => {
    const s = await boot({ features: "+modes", script: write(".ezkielyna/ezkielyna.json") })
    const ses = await newSession(s)
    const asked = await promptAnswering(s, ses.id, "change config", "reject")
    expect(asked.map((a) => a.permission)).toEqual(["edit"])
  }, 90_000)

  test("untrusted folder: the mode is forced to ask", async () => {
    const s = await boot({ features: "+modes", trusted: false, script: write("notes.md") })
    const ses = await newSession(s)
    const asked = await promptAnswering(s, ses.id, "write notes", "reject")
    expect(asked.map((a) => a.permission)).toEqual(["edit"])
    expect(fs.existsSync(path.join(s.dirs.project, "notes.md"))).toBe(false)
    const st = await s.api("GET", `/ezk/permission?directory=${encodeURIComponent(s.dirs.project)}&sessionID=${ses.id}`)
    expect(st.mode).toMatchObject({ requested: "acceptEdits", effective: "ask", trusted: false })
  }, 90_000)

  test("Rencana (plan): edit tools leave the prompt and a changing command is denied", async () => {
    const s = await boot({
      features: "+modes",
      script: [{ ok: true, tool: { name: "bash", args: { command: "rm README.md", description: "remove" } } }, { ok: true, text: "ok" }],
    })
    const ses = await newSession(s)
    await s.api("POST", "/ezk/permission/mode", { directory: s.dirs.project, sessionID: ses.id, mode: "plan" })
    const asked = await promptAnswering(s, ses.id, "clean up", "once")
    expect(asked).toEqual([])
    expect(toolNames(0)).not.toContain("write")
    expect(toolNames(0)).not.toContain("edit")
    expect(toolNames(0)).toContain("read")
    expect(fs.existsSync(path.join(s.dirs.project, "README.md"))).toBe(true)
    expect(sent(0)).toContain("Permission mode is now plan")
    const st = await s.api("GET", `/ezk/permission?directory=${encodeURIComponent(s.dirs.project)}`)
    expect(st.denied.map((d: any) => `${d.permission}:${d.why}`)).toContain("bash:plan")
  }, 90_000)

  test("config permission.mode is accepted by the config schema and applied", async () => {
    const s = await boot({ features: "+modes", config: { permission: { mode: "ask" } }, script: write("notes.md") })
    const ses = await newSession(s)
    const asked = await promptAnswering(s, ses.id, "write notes", "reject")
    expect(asked.map((a) => a.permission)).toEqual(["edit"])
  }, 90_000)
})

describe("remembered rules (S2)", () => {
  test("Bash(echo *) saved via 'always allow in this project' runs; a compound command still asks", async () => {
    const s = await boot({
      features: "+rules",
      script: [
        { ok: true, tool: { name: "bash", args: { command: "echo hi", description: "say hi" } } },
        { ok: true, text: "said hi" },
        { ok: true, tool: { name: "bash", args: { command: "echo hi; rm README.md", description: "two" } } },
        { ok: true, text: "stopped" },
      ],
    })
    // a compound approval offers both prefixes; the destructive one is never saved for the whole project
    const saved = await s.api("POST", "/ezk/permission/remember", { directory: s.dirs.project, permission: "bash", patterns: ["echo *", "rm *"] })
    expect(saved.saved).toEqual(["Bash(echo *)"])
    expect(saved.skipped).toEqual(["rm *"])
    expect(fs.readFileSync(path.join(s.dirs.project, ".ezkielyna", ".gitignore"), "utf8")).toContain("settings.local.json")
    const ses = await newSession(s)
    expect(await promptAnswering(s, ses.id, "say hi", "reject")).toEqual([])
    const asked = await promptAnswering(s, ses.id, "say hi and delete", "reject")
    expect(asked.map((a) => a.permission)).toEqual(["bash"])
    expect(fs.existsSync(path.join(s.dirs.project, "README.md"))).toBe(true)
    const st = await s.api("GET", `/ezk/permission?directory=${encodeURIComponent(s.dirs.project)}`)
    expect(st.rules.map((r: any) => r.rule)).toContain("Bash(echo *)")
    expect(st.denied.map((d: any) => d.why)).toContain("user")
  }, 90_000)

  test("an untrusted folder cannot save allow rules", async () => {
    const s = await boot({ features: "+rules", trusted: false })
    await expect(s.api("POST", "/ezk/permission/remember", { directory: s.dirs.project, permission: "bash", patterns: ["echo *"] })).rejects.toThrow("409")
  }, 90_000)
})

describe("prompt bytes", () => {
  // DESIGN-V3 rule 2: the mode is never in the system prompt; only Rencana changes the tool list (by design)
  async function capture(features: string, mode?: string) {
    const s = await boot({ features, mode })
    const ses = await newSession(s)
    await prompt(s, ses.id, "say hi", MODEL)
    const norm = (v: unknown) => JSON.stringify(v).split(s.dir).join("<TMP>")
    const out = { system: norm(gw!.requests[0]!.body.messages.filter((m: any) => m.role === "system")), tools: norm(gw!.requests[0]!.body.tools) }
    await srv!.stop()
    gw!.stop()
    srv = gw = undefined
    return out
  }

  test("safety flags on (ask, Edit otomatis, full) keep system prompt and tools byte-identical to flags off", async () => {
    // The OS sandbox lane (ezk-wc-sandbox) is on by default in Edit otomatis and adds its own text to the shell tool, so it is
    // switched off here: this test is about the safety flags only. Sandbox prompt bytes are covered by its own tests.
    const off = await capture("-modes,-rules,-hooks,-sandbox")
    for (const mode of ["ask", "acceptEdits", "full"]) expect(await capture("+modes,+rules,+hooks,-sandbox", mode)).toEqual(off)
  }, 240_000)
})

describe("trust (S4)", () => {
  test("trust, list and remove through /ezk/trust", async () => {
    const s = await boot({ trusted: false })
    const q = `?directory=${encodeURIComponent(s.dirs.project)}`
    expect(await s.api("GET", `/ezk/trust${q}`)).toMatchObject({ enabled: true, trusted: false, list: [] })
    const after = await s.api("POST", "/ezk/trust", { directory: s.dirs.project })
    expect(after.trusted).toBe(true)
    expect(after.list).toHaveLength(1)
    const removed = await s.api("POST", "/ezk/trust/remove", { directory: s.dirs.project, path: after.list[0] })
    expect(removed).toMatchObject({ removed: true, list: [] })
  }, 90_000)
})
