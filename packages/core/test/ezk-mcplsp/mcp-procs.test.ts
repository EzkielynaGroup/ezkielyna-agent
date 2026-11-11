import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { descendantsSync, killTreeSync, mcpProcs } from "../../src/ezk/mcp/procs"
import { RestartGate } from "../../src/ezk/mcp/restart"
import { capChars, withDeadline } from "../../src/ezk/mcp/limits"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("RestartGate", () => {
  test("allows exactly 2 restarts, then refuses, per server", () => {
    const g = new RestartGate(2)
    expect(g.take("a")).toBe(1)
    expect(g.take("a")).toBe(2)
    expect(g.take("a")).toBeUndefined()
    expect(g.take("b")).toBe(1)
    g.reset("a")
    expect(g.take("a")).toBe(1)
  })
  test("budget returns after the window", () => {
    let t = 0
    const g = new RestartGate(2, 1000, () => t)
    g.take("a")
    g.take("a")
    expect(g.take("a")).toBeUndefined()
    t = 1500
    expect(g.take("a")).toBe(1)
  })
  test("message is clear and has no secrets", () => {
    expect(RestartGate.failureMessage("db", 2, "exit 1")).toContain('"db"')
    expect(RestartGate.delayMs(1)).toBeLessThan(RestartGate.delayMs(2))
  })
})

describe("limits", () => {
  test("capChars", () => {
    expect(capChars("abc", 5)).toEqual({ text: "abc", omitted: 0 })
    expect(capChars("abcdef", 4)).toEqual({ text: "abcd", omitted: 2 })
  })
  test("withDeadline rejects slow work and passes fast work", async () => {
    await expect(withDeadline(new Promise(() => {}), 30, "call")).rejects.toThrow("call timed out")
    expect(await withDeadline(Promise.resolve(3), 1000, "x")).toBe(3)
  })
})

describe("process tree kill", () => {
  test("pure BFS", () => {
    const tree: Record<number, number[]> = { 10: [11, 12], 11: [13] }
    expect(descendantsSync(10, (p) => tree[p] ?? [], "linux").sort()).toEqual([11, 12, 13])
    expect(descendantsSync(10, () => [1], "win32")).toEqual([])
  })
  test.skipIf(process.platform === "win32")("kills a server and its grandchildren (npx-style wrapper)", async () => {
    // sh -> sleep (child) and sh -> sh -> sleep (grandchild)
    const child = spawn("sh", ["-c", "sleep 60 & sh -c 'sleep 60; true' & wait"], { stdio: "ignore" })
    mcpProcs.add(child.pid)
    await sleep(400)
    const kids = descendantsSync(child.pid!)
    expect(kids.length).toBeGreaterThanOrEqual(3)
    expect(mcpProcs.size()).toBe(1)
    mcpProcs.killAll()
    await sleep(300)
    expect(alive(child.pid!)).toBe(false)
    for (const k of kids) expect(alive(k)).toBe(false)
    expect(mcpProcs.size()).toBe(0)
  })
  test("refuses pid <= 1 and own pid", () => {
    killTreeSync(1)
    killTreeSync(process.pid)
    expect(alive(process.pid)).toBe(true)
  })
})
