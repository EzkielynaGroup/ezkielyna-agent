import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { EzkContextPlugin, resetContextPlugin } from "../../src/plugin/ezk/context"
import { ezkRuntime, resetEzkRuntime } from "../../src/plugin/ezk/runtime"

let dir: string
const prev = process.env.EZK_FEATURES
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-plug-"))
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }))
  fs.mkdirSync(path.join(dir, "src"))
  fs.writeFileSync(path.join(dir, "src", "a.ts"), "")
  resetEzkRuntime()
  resetContextPlugin()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  if (prev === undefined) delete process.env.EZK_FEATURES
  else process.env.EZK_FEATURES = prev
  resetEzkRuntime()
})

const msg = (id: string, text: string, role = "user") => ({
  info: { id, sessionID: "ses_ctx", role } as any,
  parts: [{ id: `prt_${id}`, messageID: id, sessionID: "ses_ctx", type: "text", text }] as any[],
})
const run = async (messages: ReturnType<typeof msg>[]) => {
  const hooks = await EzkContextPlugin({ directory: dir, worktree: dir } as any)
  await hooks["experimental.chat.messages.transform"]?.({}, { messages: messages as any })
  return messages
}
const texts = (m: ReturnType<typeof msg>) => m.parts.map((p) => p.text).join("\n")

describe("context plugin (reminders only)", () => {
  test("flags off (default): returns no hooks and touches nothing", async () => {
    delete process.env.EZK_FEATURES
    const hooks = await EzkContextPlugin({ directory: dir, worktree: dir } as any)
    expect(hooks).toEqual({})
  })

  test("A9: first user message carries tree + verify; later messages do not; bytes stay the same on repeat steps", async () => {
    process.env.EZK_FEATURES = "+context.session"
    const m = await run([msg("m1", "hello"), msg("m2", "again", "assistant"), msg("m3", "more")])
    expect(texts(m[0]!)).toContain("<session_start_context>")
    expect(texts(m[0]!)).toContain("src/")
    expect(texts(m[0]!)).toContain("Verify command: npm test")
    expect(texts(m[2]!)).not.toContain("<session_start_context>")
    const first = texts(m[0]!)
    const again = await run([msg("m1", "hello"), msg("m3", "more")])
    expect(texts(again[0]!)).toBe(first)
  })

  test("A10: only fix-like prompts get the protocol, on the user message", async () => {
    process.env.EZK_FEATURES = "+context.reproduce"
    const fix = await run([msg("m1", "fix the crash on empty input")])
    expect(texts(fix[0]!)).toContain("<bug_fix_protocol>")
    const feat = await run([msg("m2", "add a dark theme toggle")])
    expect(texts(feat[0]!)).not.toContain("<bug_fix_protocol>")
    expect(texts(feat[0]!)).not.toContain("<session_start_context>")
  })

  test("ezk.verify is exposed on the runtime", () => {
    expect(ezkRuntime().verify(dir)?.command).toBe("npm test")
  })
})
