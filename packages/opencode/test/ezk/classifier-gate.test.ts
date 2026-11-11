// The opencode side of S5 (the lane could not run it): the Permission.ask gate, with an injected model call. No network.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gate, recordUserMessage, classifierState } from "../../src/ezk/classifier"
import { resetFlagsCache, setMode } from "../../src/ezk/safety"

const saved = { features: process.env.EZK_FEATURES, trust: process.env.EZK_TRUST_PROJECT }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-classifier-"))
const say = (decision: string, reason = "the user asked for it") => async () => ({ text: JSON.stringify({ decision, reason }) })
const ask = { action: "ask" as const, reason: "base" as const }
const input = (sessionID: string, pattern: string, permission = "bash") => ({ sessionID, permission, pattern, directory: dir, worktree: dir })

beforeAll(() => {
  process.env.EZK_FEATURES = "+modes,+safety.classifier"
  process.env.EZK_TRUST_PROJECT = "1"
  resetFlagsCache()
})
afterAll(() => {
  for (const [k, v] of [["EZK_FEATURES", saved.features], ["EZK_TRUST_PROJECT", saved.trust]] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  resetFlagsCache()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe("classifier gate (Permission.ask)", () => {
  test("only an effective Otomatis-aman session reaches the model", async () => {
    let calls = 0
    const call = async () => (calls++, { text: '{"decision":"allow","reason":"the user asked for the tests"}' })
    recordUserMessage("ses_mode", "please run the tests")
    for (const mode of ["ask", "acceptEdits", "plan", "full"] as const) {
      setMode("ses_mode", mode)
      expect((await gate({ ...input("ses_mode", "bun test"), call }, ask)).action).toBe("ask")
    }
    expect(calls).toBe(0)
    setMode("ses_mode", "safeAuto")
    expect((await gate({ ...input("ses_mode", "bun test"), call }, ask)).action).toBe("allow")
    expect(calls).toBe(1)
  })

  test("deny rules, remembered ask rules and non-base reasons are never turned into allow", async () => {
    setMode("ses_rules", "safeAuto")
    recordUserMessage("ses_rules", "run the tests")
    for (const decision of [{ action: "deny", reason: "rule" }, { action: "ask", reason: "rule" }, { action: "deny", reason: "base" }, { action: "ask", reason: "plan" }] as const) {
      expect((await gate({ ...input("ses_rules", "bun test"), call: say("allow") }, decision as any)).action).toBe(decision.action)
    }
  })

  test("a block stays an ask, with the reason for the user; the breaker drops the session to ask-first after 3 in a row", async () => {
    setMode("ses_block", "safeAuto")
    recordUserMessage("ses_block", "tidy up the readme")
    const first = await gate({ ...input("ses_block", "rm -rf /"), call: say("block", "destructive delete") }, ask)
    expect(first.action).toBe("ask")
    expect(first.metadata?.ezkAutoBlocked).toMatchObject({ en: expect.stringContaining("Blocked automatically"), id: expect.stringContaining("Diblokir otomatis") })
    await gate({ ...input("ses_block", "rm -rf /tmp/a"), call: say("block", "destructive delete") }, ask)
    await gate({ ...input("ses_block", "rm -rf /tmp/b"), call: say("block", "destructive delete") }, ask)
    expect(classifierState("ses_block").tripped).toBe(true)
  })

  test("protected paths and an untrusted folder never get an automatic allow", async () => {
    setMode("ses_prot", "safeAuto")
    recordUserMessage("ses_prot", "edit the hook")
    expect((await gate({ ...input("ses_prot", ".git/hooks/pre-commit", "edit"), call: say("allow") }, ask)).action).toBe("ask")
    process.env.EZK_TRUST_PROJECT = "0"
    try {
      expect((await gate({ ...input("ses_prot", "src/a.ts", "edit"), call: say("allow") }, ask)).action).toBe("ask")
    } finally {
      process.env.EZK_TRUST_PROJECT = "1"
    }
  })

  test("flag off (default): the gate is the identity", async () => {
    process.env.EZK_FEATURES = "+modes"
    resetFlagsCache()
    try {
      setMode("ses_off", "safeAuto")
      expect(await gate({ ...input("ses_off", "bun test"), call: say("allow") }, ask)).toEqual({ action: "ask" })
    } finally {
      process.env.EZK_FEATURES = "+modes,+safety.classifier"
      resetFlagsCache()
    }
  })
})
