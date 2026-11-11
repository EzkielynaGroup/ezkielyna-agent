import { describe, expect, test } from "bun:test"
import { measure, parseLines, summarizeRouter } from "../lib/events"

const run = (type: string, part: Record<string, unknown>) =>
  JSON.stringify({ type, timestamp: 0, sessionID: "s", part })
const step = (input: number, read: number, output: number, cost = 0) =>
  run("step_finish", { type: "step-finish", cost, tokens: { input, output, reasoning: 0, cache: { read, write: 0 } } })

describe("run --format json", () => {
  const stdout = [
    "not json, ignored",
    run("step_start", {}),
    run("tool_use", { tool: "bash", state: { status: "completed" } }),
    run("tool_use", { tool: "edit", state: { status: "error", error: "oldString not found in content" } }),
    run("tool_use", { tool: "read", state: { status: "error", error: "file not found" } }),
    step(400, 600, 50, 0.001),
    run("text", { text: "Selesai." }),
    step(300, 900, 20),
    JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "rate limited" } } }),
  ].join("\n")
  const metrics = measure(parseLines(stdout))

  test("counts model calls, tools and failures", () => {
    expect(metrics.turns).toBe(2)
    expect(metrics.toolCalls).toBe(3)
    expect(metrics.toolErrors.map((item) => item.tool)).toEqual(["edit", "read"])
    expect(metrics.editFailures).toBe(1)
    expect(metrics.errors).toEqual(["rate limited"])
  })

  test("sums tokens, reported cost and cache hits", () => {
    expect(metrics.tokens).toEqual({ input: 700, output: 70, reasoning: 0, cache_read: 1500, cache_write: 0 })
    expect(metrics.cost).toBeCloseTo(0.001)
    expect(metrics.cacheHitRatio).toBeCloseTo(1500 / 2200)
    expect(metrics.answer).toBe("Selesai.")
  })

  test("no events means no turns and no cache ratio", () => {
    const empty = measure(parseLines(""))
    expect(empty.turns).toBe(0)
    expect(empty.cacheHitRatio).toBeNull()
  })
})

describe("exec --json (Codex-compatible)", () => {
  const stdout = [
    { type: "thread.started", thread_id: "t1" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "1", type: "command_execution", status: "in_progress" } },
    {
      type: "item.completed",
      item: { id: "1", type: "command_execution", command: "go test ./...", status: "completed", exit_code: 0 },
    },
    { type: "item.completed", item: { id: "2", type: "file_change", status: "failed", error: "patch did not apply" } },
    { type: "item.completed", item: { id: "3", type: "mcp_tool_call", tool: "search", status: "completed" } },
    { type: "item.completed", item: { id: "4", type: "agent_message", text: "Done: fixed paginate.go" } },
    { type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 120 } },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n")
  const metrics = measure(parseLines(stdout))

  test("tool items, file-change failures and the final message", () => {
    expect(metrics.toolCalls).toBe(3)
    expect(metrics.toolErrors).toEqual([{ tool: "apply_patch", error: "patch did not apply" }])
    expect(metrics.editFailures).toBe(1)
    expect(metrics.answer).toBe("Done: fixed paginate.go")
    expect(metrics.turns).toBe(4)
  })

  test("input_tokens includes cached tokens in the Codex format", () => {
    expect(metrics.tokens.input).toBe(500)
    expect(metrics.tokens.cache_read).toBe(1500)
    expect(metrics.cacheHitRatio).toBeCloseTo(0.75)
  })

  test("turn.failed and error events become agent errors", () => {
    const failed = measure(
      parseLines(
        [{ type: "turn.started" }, { type: "turn.failed", error: { message: "budget exceeded" } }]
          .map((e) => JSON.stringify(e))
          .join("\n"),
      ),
    )
    expect(failed.errors).toEqual(["budget exceeded"])
  })
})

test("router log summary", () => {
  const log = [
    { event: "decision", tier: "light", model: "deepseek-v4.1-flash" },
    { event: "decision", tier: "heavy", model: "deepseek-v4-pro-0813" },
    { event: "fallback", model: "minimax-m3.1-flash" },
    { event: "escalation", tier: "heavy", model: "deepseek-v4-pro-0813" },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n")
  expect(summarizeRouter(log)).toEqual({
    decisions: 2,
    fallbacks: 1,
    escalations: 1,
    models: { "deepseek-v4.1-flash": 1, "deepseek-v4-pro-0813": 2, "minimax-m3.1-flash": 1 },
    tiers: { light: 1, heavy: 2 },
    lastModel: "deepseek-v4-pro-0813",
  })
  expect(summarizeRouter("").decisions).toBe(0)
})
