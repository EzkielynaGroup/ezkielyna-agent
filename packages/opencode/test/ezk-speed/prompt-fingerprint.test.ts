// CI gate: system prompt + tool bytes must not change unexpectedly (provider prompt caching).
//  1. golden: sha256 of the bytes that make up the static prefix (ezkielyna system prompt, tool descriptions, edit schema).
//     A deliberate change must regenerate it: EZK_UPDATE_GOLDEN=1 bun test ... prompt-fingerprint
//  2. per-session stability: assemble the prefix for 6 turns of one session; the guard must see no change,
//     and a negative control (timestamp injected into the prompt) must be caught.
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync, existsSync, readdirSync } from "fs"
import * as path from "path"
import { createHash } from "crypto"
import { FingerprintGuard, fingerprint, speedEnabled } from "@opencode-ai/core/ezk/speed/index"
import { SystemPrompt } from "../../src/session/system"
import { Parameters as EditParameters } from "../../src/tool/edit"
import { ToolJsonSchema } from "../../src/tool/json-schema"

const src = path.join(import.meta.dir, "../../src")
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const golden = path.join(import.meta.dir, "prompt-golden.json")

const model: any = { providerID: "ezkielyna", api: { id: "default-model" } }
const toolTxt = readdirSync(path.join(src, "tool")).filter((f) => f.endsWith(".txt")).sort()

function prefix() {
  const system = SystemPrompt.provider(model)
  const tools: Record<string, { description: string; inputSchema: unknown }> = {}
  for (const f of toolTxt) tools[f.replace(/\.txt$/, "")] = { description: readFileSync(path.join(src, "tool", f), "utf8"), inputSchema: null }
  tools.edit = { description: tools.edit!.description, inputSchema: ToolJsonSchema.fromSchema(EditParameters as any) }
  return { system, tools }
}

describe("prompt assembly fingerprint", () => {
  test("golden: static prompt prefix bytes are unchanged", () => {
    const p = prefix()
    const f = fingerprint(p)
    const current = { system: f.systemHash, toolsAndEditSchema: f.toolsHash, bytes: f.bytes, promptFiles: Object.fromEntries(readdirSync(path.join(src, "session/prompt")).sort().map((n) => [n, sha(readFileSync(path.join(src, "session/prompt", n)))])) }
    if (process.env.EZK_UPDATE_GOLDEN || !existsSync(golden)) {
      writeFileSync(golden, JSON.stringify(current, null, 2) + "\n")
      return
    }
    expect(current).toEqual(JSON.parse(readFileSync(golden, "utf8")))
  })

  test("six turns of one session assemble identical bytes", () => {
    const g = new FingerprintGuard()
    for (let turn = 1; turn <= 6; turn++) expect(g.observe("ses_a", prefix())).toBeUndefined()
  })

  test("negative control: a per-turn timestamp in the system prompt is caught", () => {
    const g = new FingerprintGuard()
    g.observe("ses_b", prefix())
    const p = prefix()
    p.system = [p.system[0] + `\nNow: ${new Date().toISOString()}`]
    expect(g.observe("ses_b", p)?.part).toBe("system")
  })

  test("default flags leave prompt-affecting features off", () => {
    expect(speedEnabled("mcp-defer", {})).toBe(false)
    expect(speedEnabled("mcp-defer", { EZK_FEATURES: "-tolerant-edit,-watchdog" })).toBe(false)
  })
})
