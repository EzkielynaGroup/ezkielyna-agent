// X1: Codex event mapping, output-schema checks, headless permission modes, exit codes and the target folder.
import { describe, expect, test } from "bun:test"
import path from "node:path"
import { CodexEventMapper } from "../../src/ezk/exec/codex-events"
import { checkOutput, parseJson } from "../../src/ezk/exec/schema-check"
import { decidePermission, exitCode, parsePermissionMode, resolveExecDirectory, schemaInstruction } from "../../src/ezk/exec/headless"

const S = "ses_1"
const tool = (id: string, name: string, state: Record<string, unknown>) => ({ type: "message.part.updated", properties: { part: { id, sessionID: S, type: "tool", tool: name, state } } })

describe("CodexEventMapper", () => {
  test("shell command: started once with the command, updated on new output, completed with exit code", () => {
    const m = new CodexEventMapper(S)
    expect(m.map(tool("p1", "bash", { status: "pending", input: {} }))).toEqual([])
    const started = m.map(tool("p1", "bash", { status: "running", input: { command: "bun test" }, metadata: { output: "" } }))
    expect(started).toEqual([{ type: "item.started", item: { id: "item_0", type: "command_execution", command: "bun test", aggregated_output: "", exit_code: null, status: "in_progress" } }])
    expect(m.map(tool("p1", "bash", { status: "running", input: { command: "bun test" }, metadata: { output: "" } }))).toEqual([])
    expect(m.map(tool("p1", "bash", { status: "running", input: { command: "bun test" }, metadata: { output: "1 pass" } }))[0]!.type).toBe("item.updated")
    const done = m.map(tool("p1", "bash", { status: "completed", input: { command: "bun test" }, metadata: { output: "1 pass\n1 fail", exit: 1 }, output: "x" }))
    expect(done).toEqual([{ type: "item.completed", item: { id: "item_0", type: "command_execution", command: "bun test", aggregated_output: "1 pass\n1 fail", exit_code: 1, status: "failed" } }])
    expect(m.map(tool("p1", "bash", { status: "completed", input: {}, metadata: {} }))).toEqual([])
  })

  test("rejected command is declined", () => {
    const m = new CodexEventMapper(S)
    const out = m.map(tool("p1", "bash", { status: "error", input: { command: "rm -rf x" }, error: "The user rejected permission to use this specific tool call." }))
    expect(out.map((e) => e.type)).toEqual(["item.started", "item.completed"])
    expect(out[1]).toMatchObject({ item: { status: "declined", exit_code: null } })
  })

  test("edits become file_change, todos todo_list, other tools mcp_tool_call", () => {
    const m = new CodexEventMapper(S)
    expect(m.map(tool("e", "edit", { status: "running", input: { filePath: "/p/a.ts" } }))).toEqual([])
    expect(m.map(tool("e", "edit", { status: "completed", input: { filePath: "/p/a.ts" }, metadata: {} }))).toEqual([
      { type: "item.completed", item: { id: "item_0", type: "file_change", changes: [{ path: "/p/a.ts", kind: "update" }], status: "completed" } },
    ])
    expect(m.map(tool("w", "write", { status: "completed", input: { filePath: "/p/new.ts" }, metadata: { exists: false } }))[0]).toMatchObject({ item: { changes: [{ path: "/p/new.ts", kind: "add" }] } })
    expect(
      m.map(tool("ap", "apply_patch", { status: "completed", input: {}, metadata: { files: [{ relativePath: "x.ts", type: "delete" }, { relativePath: "y.ts", type: "add" }] } }))[0],
    ).toMatchObject({ item: { changes: [{ path: "x.ts", kind: "delete" }, { path: "y.ts", kind: "add" }] } })
    expect(m.map(tool("t", "todowrite", { status: "completed", input: { todos: [{ content: "a", status: "completed" }, { content: "b", status: "pending" }] } }))[0]).toMatchObject({
      item: { type: "todo_list", items: [{ text: "a", completed: true }, { text: "b", completed: false }] },
    })
    const read = m.map(tool("r", "read", { status: "completed", input: { filePath: "a" }, output: "content" }))
    expect(read.map((e) => e.type)).toEqual(["item.started", "item.completed"])
    expect(read[1]).toMatchObject({ item: { type: "mcp_tool_call", server: "ezkielyna", tool: "read", status: "completed", result: { content: [{ type: "text", text: "content" }] }, error: null } })
  })

  test("messages, reasoning, usage, other sessions and synthetic parts", () => {
    const m = new CodexEventMapper(S)
    const text = (id: string, extra: Record<string, unknown> = {}) => ({ type: "message.part.updated", properties: { part: { id, sessionID: S, type: "text", text: " hello ", time: { start: 1, end: 2 }, ...extra } } })
    expect(m.map(text("t0", { time: { start: 1 } }))).toEqual([])
    expect(m.map(text("t1"))).toEqual([{ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "hello" } }])
    expect(m.lastMessage).toBe("hello")
    expect(m.map(text("t2", { synthetic: true }))).toEqual([])
    expect(m.map({ type: "message.part.updated", properties: { part: { id: "x", sessionID: "other", type: "text", text: "no", time: { end: 1 } } } })).toEqual([])
    expect(m.map({ type: "message.part.updated", properties: { part: { id: "r", sessionID: S, type: "reasoning", text: "think", time: { end: 1 } } } })[0]).toMatchObject({ item: { type: "reasoning", text: "think" } })
    m.turnStarted()
    const info = { id: "msg_1", sessionID: S, role: "assistant", time: { completed: 1 }, modelID: "m", providerID: "p", cost: 0, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 90, write: 0 } } }
    m.map({ type: "message.updated", properties: { info } })
    m.map({ type: "message.updated", properties: { info } })
    expect(m.turnCompleted()).toEqual({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 90, output_tokens: 7 } })
    expect(m.completedSteps()).toHaveLength(1)
    expect(m.turnStarted()).toEqual({ type: "turn.started" })
    expect(m.turnCompleted()).toEqual({ type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } })
  })

  test("errors: session.error and failed assistant messages (aborts are not errors)", () => {
    const m = new CodexEventMapper(S)
    expect(m.map({ type: "session.error", properties: { sessionID: S, error: { name: "APIError", data: { message: "quota exceeded" } } } })).toEqual([{ type: "error", message: "quota exceeded" }])
    const failed = { id: "m2", sessionID: S, role: "assistant", time: { completed: 1 }, tokens: {}, error: { name: "X", data: { message: "bad gateway" } } }
    expect(m.map({ type: "message.updated", properties: { info: failed } })[0]).toMatchObject({ item: { type: "error", message: "bad gateway" } })
    const aborted = { ...failed, id: "m3", error: { name: "MessageAbortedError", data: { message: "Aborted" } } }
    expect(m.map({ type: "message.updated", properties: { info: aborted } })).toEqual([])
    expect(m.errors).toEqual(["quota exceeded", "bad gateway"])
  })
})

describe("output schema", () => {
  const schema = {
    type: "object",
    properties: { status: { enum: ["pass", "fail"] }, count: { type: "integer", minimum: 0 }, files: { type: "array", items: { $ref: "#/$defs/file" } } },
    required: ["status", "count"],
    additionalProperties: false,
    $defs: { file: { type: "string", minLength: 1 } },
  }
  test("valid JSON, also inside one code fence", () => {
    expect(checkOutput('{"status":"pass","count":3,"files":["a"]}', schema)).toEqual({ ok: true, value: { status: "pass", count: 3, files: ["a"] } })
    expect(checkOutput('Here:\n```json\n{"status":"fail","count":0}\n```', schema).ok).toBe(true)
  })
  test("errors name the path", () => {
    const r = checkOutput('{"status":"maybe","count":-1,"files":[""],"extra":true}', schema)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors).toEqual([
      '$.status: must be one of ["pass","fail"]',
      "$.count: must be >= 0",
      "$.files[0]: shorter than 1",
      "$.extra: is not allowed",
    ])
    expect(checkOutput("not json", schema)).toEqual({ ok: false, errors: ["the final message is not valid JSON"] })
    expect(checkOutput("{}", schema)).toMatchObject({ errors: ["$.status: is required", "$.count: is required"] })
    expect(checkOutput('"x"', { anyOf: [{ type: "number" }, { type: "boolean" }] })).toMatchObject({ ok: false })
  })
  test("parseJson and the instruction", () => {
    expect(parseJson("  [1,2] ")).toEqual([1, 2])
    expect(parseJson("nope")).toBeUndefined()
    expect(schemaInstruction({ type: "object" })).toContain('{"type":"object"}')
  })
})

describe("headless decisions", () => {
  test("permission modes and aliases", () => {
    expect(parsePermissionMode("Edit-Otomatis")).toBe("acceptEdits")
    expect(parsePermissionMode("bypassPermissions")).toBe("full")
    expect(parsePermissionMode("default")).toBe("ask")
    expect(parsePermissionMode("auto")).toBe("safeAuto") // same word, same meaning as the interactive modes
    expect(parsePermissionMode("dontAsk")).toBe("ask")
    expect(parsePermissionMode("banana")).toBeUndefined()
    expect(decidePermission("ask", "edit")).toBe("reject")
    expect(decidePermission("acceptEdits", "edit")).toBe("once")
    expect(decidePermission("acceptEdits", "bash")).toBe("reject")
    expect(decidePermission("acceptEdits", "external_directory")).toBe("reject")
    expect(decidePermission("plan", "edit")).toBe("reject")
    expect(decidePermission("safeAuto", "edit")).toBe("once")
    expect(decidePermission("full", "bash")).toBe("once")
  })
  test("untrusted folders and protected paths are denied in every mode (review M4)", () => {
    // untrusted: a mode only relaxes prompts in a trusted folder; plan stays plan
    expect(decidePermission("full", "bash", { trusted: false })).toBe("reject")
    expect(decidePermission("acceptEdits", "edit", { trusted: false, patterns: ["src/a.ts"] })).toBe("reject")
    expect(decidePermission("acceptEdits", "edit", { trusted: true, patterns: ["src/a.ts"] })).toBe("once")
    // protected paths: even Penuh (nobody can answer the forced prompt)
    for (const file of [".git/hooks/pre-commit", ".ezkielyna/settings.json", "ezkielyna.jsonc", ".github/workflows/ci.yml", "AGENTS.md", ".husky/pre-commit"]) {
      expect(decidePermission("acceptEdits", "edit", { patterns: [file], trusted: true })).toBe("reject")
      expect(decidePermission("full", "edit", { patterns: [file], trusted: true })).toBe("reject")
    }
    expect(decidePermission("full", "bash", { patterns: ["echo x > .git/hooks/pre-commit"], root: "/work/p", trusted: true })).toBe("reject")
    expect(decidePermission("full", "bash", { patterns: ["bun test"], root: "/work/p", trusted: true })).toBe("once")
  })
  test("exit codes: limit 2 > error 1 > denied 3 > ok 0", () => {
    expect(exitCode({ errors: 0, denied: 0 })).toBe(0)
    expect(exitCode({ errors: 0, denied: 2 })).toBe(3)
    expect(exitCode({ errors: 1, denied: 2 })).toBe(1)
    expect(exitCode({ errors: 0, denied: 0, schemaFailed: true })).toBe(1)
    expect(exitCode({ errors: 1, denied: 1, limit: "budget" })).toBe(2)
  })
  test("target folder: flag, then the real cwd, then PWD", () => {
    const resolve = path.posix.resolve
    expect(resolveExecDirectory({ flag: "/repo", cwd: () => "/caller", pwd: "/caller", resolve })).toBe("/repo")
    expect(resolveExecDirectory({ flag: "../repo", cwd: () => "/work/caller", pwd: "/elsewhere", resolve })).toBe("/work/repo")
    expect(resolveExecDirectory({ cwd: () => "/target", pwd: "/caller", resolve })).toBe("/target")
    const gone = () => {
      throw new Error("ENOENT")
    }
    expect(resolveExecDirectory({ cwd: gone, pwd: "/from-pwd", resolve })).toBe("/from-pwd")
    expect(resolveExecDirectory({ flag: "sub", cwd: gone, pwd: "/from-pwd", resolve })).toBe("/from-pwd/sub")
  })
})
