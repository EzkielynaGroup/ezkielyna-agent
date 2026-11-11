import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CompactionStateStore } from "../../src/ezk/compaction-state"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("compaction circuit breaker", () => {
  test("persists three ineffective attempts and resets after an effective compaction", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-compaction-state-"))
    dirs.push(dir)
    const file = path.join(dir, "breaker.json")
    const store = new CompactionStateStore(file)
    for (let i = 0; i < 3; i++) {
      store.record("ses_test", { beforeTokens: 100_000, afterTokens: 90_000, ineffective: true })
    }
    expect(new CompactionStateStore(file).blocked("ses_test")).toBe(true)
    store.record("ses_test", { beforeTokens: 100_000, afterTokens: 70_000, ineffective: false })
    expect(store.blocked("ses_test")).toBe(false)
    expect(store.get("ses_test")?.failures).toBe(0)
  })

  test("ignores unsafe session IDs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-compaction-state-"))
    dirs.push(dir)
    const store = new CompactionStateStore(path.join(dir, "breaker.json"))
    expect(store.record("../../escape", { beforeTokens: 10, afterTokens: 10, ineffective: true })).toBeUndefined()
    expect(store.blocked("../../escape")).toBe(false)
    expect(fs.existsSync(dir + "/../escape")).toBe(false)
  })
})
