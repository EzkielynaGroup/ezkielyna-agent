import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect } from "effect"
import { MCP } from "../../src/mcp/index"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(MCP.node))
const fixture = path.join(import.meta.dir, "../fixture/ezk-mcp-flaky-stdio.ts")
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
// Fixture processes spawned by this test process that are still running (the `--hang` one never exits on its own).
const fixturePids = () => {
  if (process.platform === "win32") return [] as number[]
  const out = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout ?? ""
  return out
    .split("\n")
    .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m && Number(m[2]) === process.pid && m[3].includes("ezk-mcp-flaky-stdio.ts"))
    .map((m) => Number(m[1]))
}
// No fixture may outlive its test, even when the test timed out or failed: kill stragglers, then assert none is left.
afterEach(async () => {
  const deadline = Date.now() + 6000
  while (fixturePids().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  const left = fixturePids()
  for (const pid of left) {
    try {
      process.kill(-pid, "SIGKILL") // its process group, if it leads one
    } catch {}
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  expect(left).toEqual([])
})
const lines = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0)
const ezk = (mcp: Record<string, unknown>) => ({ ezk: { mcp } }) as any

it.instance(
  "per-call timeout defaults to 60 s and honours ezk.mcp overrides",
  () =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.add("a", { type: "local", command: [process.execPath, fixture] })
      yield* mcp.add("b", { type: "local", command: [process.execPath, fixture] })
      const tools = yield* mcp.tools()
      expect(tools["a_echo"]!.timeout).toBe(60_000)
      expect(tools["a_echo"]!.server).toBe("a")
      expect(tools["b_echo"]!.timeout).toBe(5_000)
    }),
  { config: ezk({ servers: { b: { callTimeoutMs: 5000 } } }) },
)

it.instance(
  "a crashing local server is restarted at most twice, then a clear error is shown",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const log = path.join(test.directory, "starts.log")
      const mcp = yield* MCP.Service
      yield* mcp.add("flaky", {
        type: "local",
        command: [process.execPath, fixture, "--crash-after=150"],
        environment: { EZK_START_LOG: log },
      })
      const status = yield* pollWithTimeout(
        Effect.gen(function* () {
          const s = (yield* mcp.status())["flaky"]
          return s?.status === "failed" && s.error.includes("restarted 2 times") ? s : undefined
        }),
        "restart budget was not reported",
        "20 seconds",
      )
      expect((status as any).error).toContain('"flaky"')
      // 1 initial start + exactly 2 restarts; no third one
      yield* Effect.sleep("3 seconds")
      expect(lines(log)).toBe(3)
    }),
  40_000,
)

it.instance("disconnecting a server kills the whole process tree it started", () =>
  Effect.gen(function* () {
    const test = yield* TestInstance
    const pidFile = path.join(test.directory, "child.pid")
    const mcp = yield* MCP.Service
    yield* mcp.add("tree", {
      type: "local",
      command: [process.execPath, fixture, "--spawn-child"],
      environment: { EZK_CHILD_PID_FILE: pidFile },
    })
    const child = Number(fs.readFileSync(pidFile, "utf8"))
    expect(alive(child)).toBe(true)
    yield* mcp.disconnect("tree")
    yield* pollWithTimeout(Effect.sync(() => (alive(child) ? undefined : true)), "grandchild survived the disconnect")
  }),
)

it.instance("a hanging server fails within the startup timeout and does not leak", () =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const t0 = Date.now()
    const result = yield* mcp.add("hang", { type: "local", command: [process.execPath, fixture, "--hang"], timeout: 400 })
    expect((result.status as any).hang.status).toBe("failed")
    expect(Date.now() - t0).toBeLessThan(5000)
  }),
)

it.instance(
  "mcp-async: state is ready immediately while a server is still connecting",
  () =>
    Effect.gen(function* () {
      const prev = process.env.EZK_FEATURES
      process.env.EZK_FEATURES = "+mcp-async"
      try {
        const mcp = yield* MCP.Service
        const t0 = Date.now()
        yield* mcp.tools() // would wait for the 3 s hang timeout without the flag
        expect(Date.now() - t0).toBeLessThan(2500)
        const ok = yield* pollWithTimeout(
          Effect.gen(function* () {
            const t = yield* mcp.tools()
            return t["fast_echo"] ? t : undefined
          }),
          "background connect never finished",
          "10 seconds",
        )
        expect(ok["fast_echo"]).toBeDefined()
      } finally {
        if (prev === undefined) delete process.env.EZK_FEATURES
        else process.env.EZK_FEATURES = prev
      }
    }),
  {
    config: {
      mcp: {
        slowdead: { type: "local", command: [process.execPath, fixture, "--hang"], timeout: 3000 },
        fast: { type: "local", command: [process.execPath, fixture] },
      },
    } as any,
  },
  20_000,
)
