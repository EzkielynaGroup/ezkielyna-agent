// X1 mock-gateway e2e: the real `ezkielyna exec` CLI (from source) in an isolated profile. Checks the Codex JSONL event
// stream, the exit codes (0 ok, 1 error, 2 limit, 3 permission denied), --output-schema with its one retry,
// --output-last-message, --max-turns, --max-budget (router prices), --permission-mode and --resume.
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type Step, startMockGateway } from "../../../core/test/ezk/mock-gateway"

const ROOT = path.resolve(import.meta.dir, "../..")
const KEY = "test-key-not-real"
const MODEL = "deepseek-v4.1-flash"
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((fn) => fn()))

function profile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-exec-cli-"))
  const dirs = Object.fromEntries(["data", "config", "cache", "state", "project"].map((k) => [k, path.join(dir, k)])) as Record<"data" | "config" | "cache" | "state" | "project", string>
  Object.values(dirs).forEach((d) => fs.mkdirSync(d, { recursive: true }))
  fs.mkdirSync(path.join(dirs.config, "ezkielyna"), { recursive: true })
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, dirs }
}

async function exec(args: string[], script: Step[], opts: { prof?: ReturnType<typeof profile>; stdin?: string; cwd?: string; pwd?: string; noFlag?: boolean; env?: Record<string, string> } = {}) {
  const gw = startMockGateway({ models: { [KEY]: [MODEL] }, script: { [MODEL]: [...script] } })
  cleanups.push(() => gw.stop())
  const prof = opts.prof ?? profile()
  const proc = Bun.spawn(["bun", "run", path.join(ROOT, "src/index.ts"), "exec", ...(opts.noFlag ? [] : ["--cd", prof.dirs.project]), "-m", `ezkielyna/${MODEL}`, ...args], {
    cwd: opts.cwd ?? ROOT,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OPENCODE_") && !k.startsWith("XDG_") && k !== "EZK_FEATURES")),
      HOME: prof.dir,
      XDG_DATA_HOME: prof.dirs.data,
      XDG_CONFIG_HOME: prof.dirs.config,
      XDG_CACHE_HOME: prof.dirs.cache,
      XDG_STATE_HOME: prof.dirs.state,
      EZKIELYNA_BASE_URL: gw.baseURL,
      EZKIELYNA_API_KEY: KEY,
      EZK_TEST_HIDDEN: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...(opts.pwd ? { PWD: opts.pwd } : {}),
      ...(opts.env ?? {}),
    },
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const events = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line))
  return { code, stdout, stderr, events, gw, prof }
}

const bash = (command: string): Step => ({ ok: true, tool: { name: "bash", args: { command, description: "run" } } })
const say = (text: string, usage?: { prompt: number; completion: number }): Step => ({ ok: true, text, usage })

describe("ezkielyna exec", () => {
  test("--json: Codex event stream for a command and a final message, exit 0", async () => {
    const r = await exec(["--json", "--permission-mode", "full", "print hi"], [bash("echo hi-from-tool"), say("all done")])
    expect(r.code).toBe(0)
    const types = r.events.map((e) => (e.item ? `${e.type}:${e.item.type}` : e.type))
    expect(types).toEqual([
      "thread.started",
      "turn.started",
      "item.started:command_execution",
      ...types.filter((t) => t === "item.updated:command_execution"),
      "item.completed:command_execution",
      "item.completed:agent_message",
      "turn.completed",
    ])
    const started = r.events[0]
    expect(started.thread_id).toMatch(/^ses_/)
    const done = r.events.find((e) => e.type === "item.completed" && e.item.type === "command_execution")
    expect(done.item).toMatchObject({ command: "echo hi-from-tool", exit_code: 0, status: "completed" })
    expect(done.item.aggregated_output).toContain("hi-from-tool")
    expect(r.events.find((e) => e.item?.type === "agent_message").item.text).toBe("all done")
    expect(r.events.at(-1).usage).toEqual({ input_tokens: 200, cached_input_tokens: 0, output_tokens: 20 })
  }, 120_000)

  test("plain mode: final message on stdout, progress on stderr; prompt from stdin", async () => {
    const r = await exec(["-", "--permission-mode", "full"], [bash("echo x"), say("the answer")], { stdin: "what is it?" })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe("the answer")
    expect(r.stderr).toContain("$ echo x")
    expect(JSON.stringify(r.gw.requests[0]!.body.messages)).toContain("what is it?")
  }, 120_000)

  test("default permission mode denies the command: declined item, exit 3", async () => {
    const r = await exec(["--json", "run it"], [bash("echo should-not-run"), say("could not run it")])
    expect(r.code).toBe(3)
    const item = r.events.find((e) => e.type === "item.completed" && e.item.type === "command_execution").item
    expect(["declined", "failed"]).toContain(item.status)
    expect(item.aggregated_output).not.toContain("should-not-run\n")
  }, 120_000)

  test("--max-turns stops a run that keeps calling tools: turn.failed, exit 2", async () => {
    const r = await exec(["--json", "--permission-mode", "full", "--max-turns", "1", "loop"], [bash("echo 1"), bash("echo 2"), bash("echo 3"), say("never")])
    expect(r.code).toBe(2)
    expect(r.events.at(-1)).toEqual({ type: "turn.failed", error: { message: "stopped: --max-turns 1 reached" } })
    expect(r.gw.requests.length).toBeLessThanOrEqual(2)
  }, 120_000)

  test("--max-budget uses the router price book: exit 2", async () => {
    // deepseek-v4.1-flash static price: $0.00375 per 1M input tokens -> 400M tokens is about $1.50 per step
    const big = { ok: true as const, tool: { name: "bash", args: { command: "echo big", description: "run" } }, usage: { prompt: 400_000_000, completion: 10 } }
    const r = await exec(["--json", "--permission-mode", "full", "--max-budget", "1", "spend"], [big, big, say("never")])
    expect(r.code).toBe(2)
    expect(r.events.at(-1).error.message).toBe("stopped: --max-budget $1 reached")
  }, 120_000)

  test("--output-schema: invalid first answer gets one retry; the valid JSON lands in -o", async () => {
    const prof = profile()
    const schemaFile = path.join(prof.dir, "schema.json")
    const out = path.join(prof.dir, "out", "last.json")
    fs.writeFileSync(schemaFile, JSON.stringify({ type: "object", properties: { passed: { type: "boolean" }, count: { type: "integer" } }, required: ["passed", "count"], additionalProperties: false }))
    const r = await exec(["--json", "--output-schema", schemaFile, "-o", out, "summarise"], [say("All tests passed!"), say('```json\n{"passed": true, "count": 12}\n```')], { prof })
    expect(r.code).toBe(0)
    expect(r.events.filter((e) => e.type === "turn.started")).toHaveLength(2)
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ passed: true, count: 12 })
    expect(JSON.stringify(r.gw.requests[0]!.body.messages)).toContain("<output-format>")
    expect(JSON.stringify(r.gw.requests[1]!.body.messages)).toContain("did not match the required JSON Schema")
  }, 120_000)

  test("--output-schema still wrong after the retry: error event, exit 1", async () => {
    const prof = profile()
    const schemaFile = path.join(prof.dir, "schema.json")
    fs.writeFileSync(schemaFile, JSON.stringify({ type: "object", required: ["passed"] }))
    const r = await exec(["--json", "--output-schema", schemaFile, "summarise"], [say("nope"), say('{"other": 1}')], { prof })
    expect(r.code).toBe(1)
    expect(r.events.at(-1).type).toBe("error")
    expect(r.events.at(-1).message).toContain("$.passed: is required")
  }, 120_000)

  test("--resume continues the same thread with its history", async () => {
    const prof = profile()
    const first = await exec(["--json", "remember the word kumquat"], [say("noted")], { prof })
    const id = first.events[0].thread_id
    const second = await exec(["--json", "--resume", id, "what was the word?"], [say("kumquat")], { prof })
    expect(second.code).toBe(0)
    expect(second.events[0]).toEqual({ type: "thread.started", thread_id: id })
    expect(JSON.stringify(second.gw.requests[0]!.body.messages)).toContain("remember the word kumquat")
    const missing = await exec(["--json", "--resume", "ses_does_not_exist", "hi"], [say("x")], { prof })
    expect(missing.code).toBe(1)
    expect(missing.events[0].type).toBe("error")
  }, 180_000)

  test("target folder: --cwd wins over the caller's folder and a stale PWD", async () => {
    const prof = profile()
    const caller = path.join(prof.dir, "caller")
    fs.mkdirSync(caller)
    const workdir = (r: Awaited<ReturnType<typeof exec>>) => /Working directory: (\S+)/.exec(r.gw.requests[0]!.system)?.[1]
    const target = fs.realpathSync(prof.dirs.project)

    const flagged = await exec(["--json", "--cwd", target, "hi"], [say("ok")], { prof, cwd: caller, pwd: caller, noFlag: true })
    expect(flagged.code).toBe(0)
    expect(workdir(flagged)).toBe(target)

    const relative = await exec(["--json", "-C", "../project", "hi"], [say("ok")], { prof, cwd: caller, pwd: caller, noFlag: true })
    expect(workdir(relative)).toBe(target)

    // spawned with cwd = target but PWD still pointing at the caller (what a bench harness or CI step does)
    const spawned = await exec(["--json", "hi"], [say("ok")], { prof, cwd: target, pwd: caller, noFlag: true })
    expect(workdir(spawned)).toBe(target)

    const missing = await exec(["--cwd", path.join(prof.dir, "nope"), "hi"], [], { prof, noFlag: true })
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain("Folder not found")
  }, 180_000)

  test("an untrusted folder answers every request with deny, whatever the mode (review M4)", async () => {
    const prof = profile()
    const marker = path.join(prof.dirs.project, "ran-anyway")
    const r = await exec(["--permission-mode", "full", "print hi"], [bash(`touch "${marker}"`), say("done")], { prof, env: { EZK_TRUST_PROJECT: "0" } })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("This folder is not trusted, so --permission-mode full is ignored. Run: ezkielyna trust")
    expect(r.stderr).toMatch(/denied (bash|external_directory)/)
    expect(fs.existsSync(marker)).toBe(false)
  }, 180_000)

  test("edits to protected paths are denied even in full mode (review M4)", async () => {
    const prof = profile()
    const target = path.join(prof.dirs.project, ".git", "hooks", "pre-commit")
    const r = await exec(["--permission-mode", "full", "add a hook"], [{ ok: true, tool: { name: "write", args: { filePath: target, content: "#!/bin/sh\necho pwned\n" } } }, say("done")], { prof })
    expect(r.code).toBe(3)
    expect(r.stderr).toContain("denied edit")
    expect(fs.existsSync(target)).toBe(false)
  }, 180_000)

  test("bad flags fail fast with exit 1", async () => {
    const r = await exec(["--permission-mode", "banana", "hi"], [])
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("Unknown --permission-mode")
  }, 120_000)
})
