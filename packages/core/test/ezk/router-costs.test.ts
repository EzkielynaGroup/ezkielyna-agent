import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionCosts } from "../../src/ezk/router/costs"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("SessionCosts", () => {
  test("spend survives restart and replaces duplicate message costs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-costs-"))
    dirs.push(dir)
    const file = path.join(dir, "ezk", "session-costs.jsonl")
    const first = new SessionCosts(file)
    first.setMessageCost("session-1", "assistant-1", 0.4)
    first.setMessageCost("session-1", "assistant-1", 0.45)
    first.setMessageCost("session-2", "assistant-2", 0.2)

    expect(new SessionCosts(file).forSession("session-1")).toEqual([["assistant-1", 0.45]])
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })
})
