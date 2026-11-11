// Mock-gateway e2e: replays real model mistakes against the edit pipeline.
// The pipeline below is the same sequence edit.ts runs (normalize keys -> resolve path -> read -> line-ending
// conversion -> applyReplace (upstream matcher ladder + EZK recovery) -> write); only the Effect layers
// (permissions, LSP, formatter, events) are not started.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { applyReplace } from "../../src/tool/edit"
import { normalizeEditArgs, resolveEditPath } from "@opencode-ai/core/ezk/speed/index"
import * as Patch from "../../src/patch"
import { nextToolCall, startMockGateway, type Script } from "./mock-gateway"

const normalizeLE = (t: string) => t.replaceAll("\r\n", "\n")

function runEdit(cwd: string, rawArgs: string, tolerant: boolean): { ok: true } | { ok: false; error: string } {
  try {
    const parsed = JSON.parse(rawArgs)
    const a: any = tolerant ? normalizeEditArgs(parsed).args : parsed
    if (typeof a.filePath !== "string" || typeof a.oldString !== "string" || typeof a.newString !== "string") throw new Error("invalid arguments")
    const filePath = tolerant
      ? resolveEditPath(a.filePath, { cwd, exists: existsSync, isAbsolute: path.isAbsolute }).path
      : path.isAbsolute(a.filePath) ? a.filePath : path.join(cwd, a.filePath)
    if (!existsSync(filePath)) throw new Error(`File ${filePath} not found`)
    const content = readFileSync(filePath, "utf8")
    const ending = content.includes("\r\n") ? "\r\n" : "\n"
    const conv = (t: string) => (ending === "\n" ? normalizeLE(t) : normalizeLE(t).replaceAll("\n", "\r\n"))
    const next = tolerant ? applyReplace(content, conv(a.oldString), conv(a.newString), a.replaceAll) : (require("../../src/tool/edit").replace as any)(content, conv(a.oldString), conv(a.newString), a.replaceAll)
    writeFileSync(filePath, next)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

let dir: string
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ezk-speed-e2e-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Case {
  name: string
  file: string
  content: string
  args: Record<string, unknown> | ((file: string) => Record<string, unknown>)
  expect: string // expected file content after (or unchanged content when `fails`)
  fails?: boolean // must NOT be recovered (safety)
  baselineFails: boolean // does the untouched upstream pipeline fail on this mistake?
}

const cases: Case[] = [
  { name: "snake_case keys", file: "a.ts", content: "let x = 1\n", args: { file_path: "a.ts", old_string: "let x = 1", new_string: "let x = 2" }, expect: "let x = 2\n", baselineFails: true },
  { name: "path/find/replace synonyms", file: "a2.ts", content: "let y = 1\n", args: { path: "a2.ts", find: "let y = 1", replace: "let y = 3" }, expect: "let y = 3\n", baselineFails: true },
  { name: "replace_all as the string 'true'", file: "ra.ts", content: "a a a\n", args: { filePath: "ra.ts", oldString: "a", newString: "b", replace_all: "true" }, expect: "b b b\n", baselineFails: true },
  { name: "project-relative path with leading slash", file: "src/b.ts", content: "const b = 1\n", args: { filePath: "/src/b.ts", oldString: "const b = 1", newString: "const b = 2" }, expect: "const b = 2\n", baselineFails: true },
  { name: "file:// URL", file: "c.ts", content: "c()\n", args: (f) => ({ filePath: "file://" + f, oldString: "c()", newString: "d()" }), expect: "d()\n", baselineFails: true },
  { name: "quoted path + :line suffix", file: "d.ts", content: "d()\n", args: { filePath: '"d.ts:1"', oldString: "d()", newString: "e()" }, expect: "e()\n", baselineFails: true },
  { name: "smart quotes in file, straight in oldString", file: "q.md", content: "say “hi” to the world\n", args: { filePath: "q.md", oldString: 'say "hi" to', newString: 'say "yo" to' }, expect: 'say "yo" to the world\n', baselineFails: true },
  { name: "line numbers copied from read output", file: "n.ts", content: "function f() {\n  return 1\n}\n", args: { filePath: "n.ts", oldString: "1→function f() {\n2→  return 1\n3→}", newString: "1→function f() {\n2→  return 2\n3→}" }, expect: "function f() {\n  return 2\n}\n", baselineFails: true },
  { name: "code fence around the snippet", file: "f.py", content: "a = 1\nb = 2\n", args: { filePath: "f.py", oldString: "```python\na = 1\nb = 2\n```", newString: "```python\na = 1\nb = 3\n```" }, expect: "a = 1\nb = 3\n", baselineFails: true },
  { name: "CRLF file, LF oldString (upstream already handles)", file: "crlf.txt", content: "one\r\ntwo\r\n", args: { filePath: "crlf.txt", oldString: "one\ntwo", newString: "one\n2" }, expect: "one\r\n2\r\n", baselineFails: false },
  { name: "wrong indentation (upstream already handles)", file: "i.ts", content: "if (x) {\n    run()\n}\n", args: { filePath: "i.ts", oldString: "if (x) {\n  run()\n}", newString: "if (x) {\n    go()\n}" }, expect: "if (x) {\n    go()\n}\n", baselineFails: false },
  // safety: must stay failures and leave files untouched
  { name: "SAFETY ambiguous smart-quote match is not guessed", file: "amb.md", content: "“a”\n“a”\n", args: { filePath: "amb.md", oldString: '"a"', newString: '"b"' }, expect: "“a”\n“a”\n", fails: true, baselineFails: true },
  { name: "SAFETY oldString absent stays an error", file: "none.ts", content: "x\n", args: { filePath: "none.ts", oldString: "nothing like this", newString: "y" }, expect: "x\n", fails: true, baselineFails: true },
  { name: "SAFETY missing file is not created or redirected", file: "real.ts", content: "r\n", args: { filePath: "ghost.ts", oldString: "r", newString: "s" }, expect: "r\n", fails: true, baselineFails: true },
]

describe("mock gateway replays edit mistakes", () => {

  let tolerantOk = 0
  let baselineOk = 0
  let recoverable = 0
  for (const c of cases) {
    test(c.name, async () => {
      const file = path.join(dir, c.file)
      const run = (tolerant: boolean) => {
        mkdirSync(path.dirname(file), { recursive: true })
        writeFileSync(file, c.content)
        const args = typeof c.args === "function" ? c.args(file) : c.args
        return runEdit(dir, JSON.stringify(args), tolerant)
      }
      // 1) the mock gateway really streams the (mistaken) tool call; the client reassembles it from SSE chunks
      const local = startMockGateway([{ kind: "tool", name: "edit", args: typeof c.args === "function" ? c.args(file) : c.args }])
      const got = await nextToolCall(local.url)
      local.stop()
      expect(got.name).toBe("edit")
      expect(JSON.parse(got.args)).toEqual(typeof c.args === "function" ? c.args(file) : c.args)
      // 2) baseline (upstream behaviour) vs tolerant
      const base = run(false)
      expect(base.ok).toBe(!c.baselineFails)
      if (!c.fails) {
        recoverable++
        if (base.ok) baselineOk++
      }
      writeFileSync(file, c.content)
      const t = run(true)
      if (c.fails) {
        expect(t.ok).toBe(false)
        expect(readFileSync(file, "utf8")).toBe(c.expect) // untouched
        if (c.file === "real.ts") expect(existsSync(path.join(dir, "ghost.ts"))).toBe(false)
      } else {
        expect(t).toEqual({ ok: true })
        expect(readFileSync(file, "utf8")).toBe(c.expect)
        tolerantOk++
      }
    })
  }
  test("summary", () => {
    console.log(`edit replay: ${recoverable} recoverable mistakes: upstream OK ${baselineOk}/${recoverable}, tolerant OK ${tolerantOk}/${recoverable}; 3 safety cases stay failures`)
    expect(tolerantOk).toBe(recoverable)
    expect(baselineOk).toBeLessThan(recoverable)
  })
})

describe("mock gateway apply_patch replay by model family", () => {
  const traces = ["gpt-5.2", "claude-sonnet", "gemini-flash", "deepseek-chat"].map((model, index) => ({
    model,
    content: `const value = ${index + 1}\n`,
    patchText: `*** Begin Patch\n*** Update File: replay-${index}.ts\n@@\n-const value = ${index + 1}\n+const value = ${index + 11}\n*** End Patch`,
    expected: `const value = ${index + 11}\n`,
  }))

  let successes = 0
  let editSuccesses = 0
  for (const trace of traces) {
    test(`${trace.model} first-try patch`, async () => {
      const gateway = startMockGateway([
        { kind: "tool", name: "apply_patch", args: { patchText: trace.patchText } },
      ])
      const toolCall = await nextToolCall(gateway.url)
      gateway.stop()
      expect(toolCall.name).toBe("apply_patch")
      const parsed = Patch.parsePatch(JSON.parse(toolCall.args).patchText)
      const update = parsed.hunks[0]
      expect(update?.type).toBe("update")
      if (!update || update.type !== "update") throw new Error("expected update patch")
      const result = Patch.deriveNewContentsFromChunks("replay.ts", update.chunks, trace.content)
      expect(result.content).toBe(trace.expected)
      successes++

      const edited = applyReplace(
        trace.content,
        `const value = ${Number(trace.content.match(/\d+/)?.[0])}`,
        `const value = ${Number(trace.content.match(/\d+/)?.[0]) + 10}`,
      )
      expect(edited).toBe(trace.expected)
      editSuccesses++
    })
  }

  test("summary compares first-try patch and edit success by model family", () => {
    expect(successes).toBe(4)
    expect(editSuccesses).toBe(4)
    console.log(
      `first-try mock replay by family: apply_patch ${successes}/4, edit ${editSuccesses}/4 (GPT, Claude, Gemini, other); tied sample, retain legacy GPT preference and expose both behind flag`,
    )
  })
})
