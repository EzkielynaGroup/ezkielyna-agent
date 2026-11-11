// E3 runtime pieces used from hot files: lazy `task` permission and the per-session subagent limit.
import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { limitSubagents, taskAgent } from "../../src/ezk/subagents"
import { resetEzkRuntime } from "../../src/plugin/ezk/runtime"
import { Permission } from "../../src/permission"

const prev = process.env.EZK_FEATURES
afterEach(() => {
  process.env.EZK_FEATURES = prev
  resetEzkRuntime()
})
const on = (features: string) => {
  process.env.EZK_FEATURES = features
  resetEzkRuntime()
}

const agent = (permission: any[], mode: "primary" | "subagent" = "primary") => ({ name: "build", mode, permission, options: {}, native: true }) as any
const deny = [{ permission: "task", pattern: "*", action: "deny" }]
const reads = [
  { info: { id: "msg_1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "go" }] },
  { info: { id: "msg_2", role: "assistant", time: { created: 2 } }, parts: ["read", "grep", "glob"].map((tool) => ({ type: "tool", tool, state: { status: "completed" } })) },
] as any[]

test("flag off: the agent is returned untouched", () => {
  on("-subagents")
  const a = agent(deny)
  expect(taskAgent(a, reads)).toBe(a)
})

test("flag on: task allowed after 3 reads, general stays denied; subagents and explicit configs untouched", () => {
  on("+subagents")
  const a = agent(deny)
  expect(taskAgent(a, reads.slice(0, 1))).toBe(a)
  const next = taskAgent(a, reads)
  expect(Permission.disabled(["task"], next.permission).has("task")).toBe(false)
  expect(Permission.evaluate("task", "explore", next.permission).action).toBe("allow")
  expect(Permission.evaluate("task", "general", next.permission).action).toBe("deny")
  const sub = agent(deny, "subagent")
  expect(taskAgent(sub, reads)).toBe(sub)
  const explicit = agent([{ permission: "task", pattern: "*", action: "allow" }])
  expect(taskAgent(explicit, reads)).toBe(explicit)
})

test("at most 3 subagents of one session run at once; other tools and sessions are not limited", async () => {
  on("+subagents")
  let running = 0
  let peak = 0
  const job = Effect.gen(function* () {
    running++
    peak = Math.max(peak, running)
    yield* Effect.sleep("20 millis")
    running--
  })
  await Effect.runPromise(Effect.all(Array.from({ length: 7 }, () => limitSubagents("task", "ses_a", job)), { concurrency: "unbounded" }))
  expect(peak).toBe(3)
  peak = 0
  await Effect.runPromise(Effect.all(Array.from({ length: 5 }, () => limitSubagents("read", "ses_a", job)), { concurrency: "unbounded" }))
  expect(peak).toBe(5)
})
