import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { turnCachePercent, turnSummary, turnTestResult } from "./turn-summary"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"

function tool(input: { command: string; status: "pending" | "running" | "completed" | "error"; output?: string; error?: string }) {
  return {
    id: "part-1",
    sessionID: "session-1",
    messageID: "message-1",
    type: "tool",
    callID: "call-1",
    tool: "bash",
    state:
      input.status === "completed"
        ? {
            status: "completed",
            input: { command: input.command },
            title: input.command,
            output: input.output ?? "",
            metadata: {},
            time: { start: 1, end: 2 },
          }
        : input.status === "error"
          ? { status: "error", input: { command: input.command }, error: input.error ?? "failed", time: { start: 1, end: 2 } }
          : { status: input.status, input: { command: input.command }, raw: "" },
  } as ToolPart
}

test("reports the latest recorded test run and count", () => {
  expect(turnTestResult([tool({ command: "bun test", status: "completed", output: "4 pass" })])).toEqual({
    status: "passed",
    count: 4,
    durationMs: 1,
  })
  expect(turnTestResult([tool({ command: "bun test", status: "error", error: "2 tests failed" })])).toEqual({
    status: "failed",
    count: 2,
    durationMs: 1,
  })
})

test("does not mistake unrelated commands for tests and marks active tests as running", () => {
  expect(turnTestResult([tool({ command: "grep test package.json", status: "completed" })])).toEqual({
    status: "not-run",
  })
  expect(turnTestResult([tool({ command: "pnpm test", status: "running" })])).toEqual({ status: "running" })
})

test("summarizes the final assistant text and cache percentage without counting reasoning", () => {
  const parts = [
    { type: "text", text: "First update." },
    { type: "reasoning", text: "internal reasoning" },
    { type: "text", text: "Final result with\nwhitespace." },
  ] as Part[]
  expect(turnSummary(parts)).toBe("Final result with whitespace.")
  expect(
    turnCachePercent([
      { tokens: { input: 20, cache: { read: 60, write: 20 } } } as unknown as AssistantMessage,
    ]),
  ).toBe(60)
  expect(turnCachePercent([])).toBeUndefined()
})
