import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describeHooks, hooksFingerprint, loadHooks, matcherMatches, skippedProjectHooks, type HookGroup } from "../../src/ezk/hooks/config"
import { StopBreaker, runHooks, type HookInput } from "../../src/ezk/hooks/engine"

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-hooks-")))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
const root = path.join(base, "project")
const userConfig = path.join(base, "config")
const home = path.join(base, "home")
for (const d of [root, userConfig, home]) fs.mkdirSync(d, { recursive: true })

const write = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}
const script = (name: string, body: string) => {
  const file = path.join(base, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return file
}
const input = (event: HookInput["hook_event_name"], extra: Record<string, unknown> = {}): HookInput => ({
  session_id: "ses_1",
  cwd: root,
  permission_mode: "acceptEdits",
  hook_event_name: event,
  ...extra,
})
const group = (event: HookGroup["event"], handlers: HookGroup["handlers"], matcher?: string): HookGroup => ({ event, matcher, handlers, source: "test", scope: "user" })
const cmd = (command: string, timeoutMs = 60_000) => ({ type: "command" as const, command, timeoutMs })

describe("config", () => {
  test("reads hooks from .ezkielyna and .claude settings; project hooks only when trusted", () => {
    write(path.join(userConfig, "settings.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] } })
    write(path.join(root, ".claude", "settings.json"), { hooks: { PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "echo claude", timeout: 600 }] }] } })
    write(path.join(root, ".ezkielyna", "settings.json"), { hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "http", url: "http://127.0.0.1:1/x" }] }] } })
    const trusted = loadHooks({ root, userConfig, home, trusted: true })
    expect(trusted.map((g) => `${g.scope}:${g.event}`).sort()).toEqual(["project:PostToolUse", "project:PreToolUse", "user:Stop"])
    expect(trusted.find((g) => g.event === "PreToolUse")!.handlers[0]!.timeoutMs).toBe(60_000) // capped at 60 s
    expect(trusted.find((g) => g.event === "PostToolUse")!.matcher).toBeUndefined()
    const untrusted = loadHooks({ root, userConfig, home, trusted: false })
    expect(untrusted.map((g) => g.event)).toEqual(["Stop"])
    expect(skippedProjectHooks({ root, userConfig, home, trusted: false })).toBe(2)
    expect(describeHooks(trusted)).toHaveLength(3)
    expect(hooksFingerprint(trusted)).not.toBe(hooksFingerprint(untrusted))
  })

  test("matchers: exact, list, regex, against our id and the Claude name", () => {
    expect(matcherMatches(undefined, "bash")).toBe(true)
    expect(matcherMatches("Bash", "bash")).toBe(true)
    expect(matcherMatches("Edit|Write", "write")).toBe(true)
    expect(matcherMatches("Edit|Write", "bash")).toBe(false)
    expect(matcherMatches("mcp__.*", "mcp__github__x")).toBe(true)
    expect(matcherMatches("Web.*", "webfetch")).toBe(true)
    expect(matcherMatches("(", "bash")).toBe(false)
  })
})

describe("runHooks", () => {
  test("exit 2 blocks with stderr as the reason (block an edit)", async () => {
    const file = script("block.sh", `cat > ${base}/stdin.json; echo "no edits to generated files" >&2; exit 2`)
    const out = await runHooks([group("PreToolUse", [cmd(file)], "Edit|Write")], input("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "a.ts" } }), { root, matchValue: "edit" })
    expect(out.blocked).toBe(true)
    expect(out.reason).toBe("no edits to generated files")
    const seen = JSON.parse(fs.readFileSync(path.join(base, "stdin.json"), "utf8"))
    expect(seen).toMatchObject({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "a.ts" }, session_id: "ses_1" })
  })

  test("matcher miss runs nothing", async () => {
    const out = await runHooks([group("PreToolUse", [cmd("exit 2")], "Bash")], input("PreToolUse"), { root, matchValue: "edit" })
    expect(out).toMatchObject({ blocked: false, ran: 0 })
  })

  test("JSON stdout: permissionDecision, updatedInput, additionalContext, systemMessage", async () => {
    const json = JSON.stringify({ systemMessage: "checked", hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: "bun test --bail" }, additionalContext: "use --bail" } })
    const out = await runHooks([group("PreToolUse", [cmd(`echo '${json}'`)])], input("PreToolUse"), { root, matchValue: "bash" })
    expect(out).toMatchObject({ blocked: false, decision: "allow", updatedInput: { command: "bun test --bail" }, context: ["use --bail"], messages: ["checked"] })
  })

  test("deny beats ask beats allow across parallel hooks; duplicates run once", async () => {
    const allow = `echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}'`
    const deny = `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"policy"}}'`
    const out = await runHooks([group("PreToolUse", [cmd(allow), cmd(deny), cmd(allow)])], input("PreToolUse"), { root })
    expect(out).toMatchObject({ decision: "deny", blocked: true, reason: "policy", ran: 2 })
  })

  test("UserPromptSubmit: plain stdout is injected as context", async () => {
    const out = await runHooks([group("UserPromptSubmit", [cmd("echo 'Ticket: ABC-1'")])], input("UserPromptSubmit", { prompt: "fix it" }), { root })
    expect(out.context).toEqual(["Ticket: ABC-1"])
  })

  test("Stop: decision block with a reason forces another turn", async () => {
    const out = await runHooks([group("Stop", [cmd(`echo '{"decision":"block","reason":"run tests"}'`)])], input("Stop", { stop_hook_active: false }), { root })
    expect(out).toMatchObject({ blocked: true, reason: "run tests" })
  })

  test("continue:false stops; other exit codes are non-blocking errors", async () => {
    const out = await runHooks([group("PostToolUse", [cmd(`echo '{"continue":false,"stopReason":"budget"}'`), cmd("echo bad >&2; exit 1")])], input("PostToolUse"), { root })
    expect(out.stop).toBe("budget")
    expect(out.blocked).toBe(false)
    expect(out.messages.join("\n")).toContain("exited with 1")
  })

  test("timeout kills the hook and reports it", async () => {
    const started = Date.now()
    const out = await runHooks([group("Notification", [cmd("sleep 5", 300)])], input("Notification"), { root })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(out.messages[0]).toContain("timed out")
  })

  test("inherited provider secrets are scrubbed while hook-declared environment remains", async () => {
    const out = await runHooks(
      [group("SessionStart", [cmd('echo "ezk=${EZKIELYNA_API_KEY:-none} anthropic=${ANTHROPIC_API_KEY:-none} hook=$HOOK_DECLARED dir=$CLAUDE_PROJECT_DIR"')])],
      input("SessionStart"),
      { root, env: { ...process.env, EZKIELYNA_API_KEY: "sk-secret", ANTHROPIC_API_KEY: "sk-secret-too", HOOK_DECLARED: "visible" } },
    )
    expect(out.context).toEqual([`ezk=none anthropic=none hook=visible dir=${root}`])
  })

  test("http handler: POST JSON, JSON decision back", async () => {
    let body: any
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      body = await req.json()
      return Response.json({ decision: "block", reason: "remote policy" })
    } })
    try {
      const out = await runHooks([group("PostToolUse", [{ type: "http", url: `http://127.0.0.1:${server.port}/hook`, headers: {}, timeoutMs: 5000 }])], input("PostToolUse", { tool_name: "Bash" }), { root })
      expect(body).toMatchObject({ hook_event_name: "PostToolUse", tool_name: "Bash" })
      expect(out).toMatchObject({ blocked: true, reason: "remote policy" })
    } finally {
      server.stop(true)
    }
  })
})

describe("StopBreaker", () => {
  test("opens after 8 consecutive blocks and resets", () => {
    const b = new StopBreaker()
    for (let i = 0; i < 8; i++) expect(b.block("s")).toBe(true)
    expect(b.block("s")).toBe(false)
    b.reset("s")
    expect(b.active("s")).toBe(false)
    expect(b.block("s")).toBe(true)
  })
})
