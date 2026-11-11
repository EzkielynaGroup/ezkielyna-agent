import { expect, test } from "bun:test"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { formatStepDuration, inlineDiffPreview, sessionToolSteps } from "./session-tool-steps"

const tool = (input: Partial<ToolPart> & { id: string; tool: string; input?: Record<string, unknown>; output?: string; metadata?: Record<string, unknown> }) => ({
  id: input.id,
  sessionID: "ses_fixture",
  messageID: "msg_fixture",
  type: "tool",
  callID: `call_${input.id}`,
  tool: input.tool,
  state: {
    status: "completed",
    input: input.input ?? {},
    output: input.output ?? "",
    title: input.tool,
    metadata: input.metadata ?? {},
    time: { start: 1_000, end: 5_200 },
  },
}) as ToolPart

test("maps read/search, edit, write and test tools into concise step rows", () => {
  const rows = sessionToolSteps([
    tool({ id: "read-a", tool: "read", input: { filePath: "src/checkout.ts" } }),
    tool({ id: "grep-a", tool: "grep", input: { path: "src/coupon.ts" } }),
    tool({ id: "list-a", tool: "list", input: { path: "src/checkout.test.ts" } }),
    tool({ id: "read-duplicate", tool: "read", input: { filePath: "src/checkout.ts" } }),
    tool({
      id: "edit-a",
      tool: "apply_patch",
      input: { filePath: "src/payment/checkout.ts" },
      metadata: { filediff: { file: "src/payment/checkout.ts", additions: 12, deletions: 3 } },
    }),
    tool({ id: "write-a", tool: "write", input: { filePath: "src/payment/checkout.test.ts" }, metadata: { filediff: { additions: 18, deletions: 0 } } }),
    tool({ id: "test-a", tool: "bash", input: { command: "npm test" }, output: "24 tests passed", metadata: { exit: 0 } }),
  ])

  expect(rows).toEqual([
    { id: "read-a", partIDs: ["read-a", "grep-a", "list-a", "read-duplicate"], kind: "read", paths: ["src/checkout.ts", "src/coupon.ts", "src/checkout.test.ts"], count: 3 },
    { id: "edit-a", partIDs: ["edit-a"], kind: "edit", path: "src/payment/checkout.ts", additions: 12, deletions: 3 },
    { id: "write-a", partIDs: ["write-a"], kind: "write", path: "src/payment/checkout.test.ts", additions: 18, deletions: undefined },
    { id: "test-a", partIDs: ["test-a"], kind: "test", command: "npm test", status: "passed", count: 24, durationMs: 4_200 },
  ])
  expect(formatStepDuration(4_200, "id")).toBe("4,2")
  expect(formatStepDuration(4_200, "en")).toBe("4.2")
  expect(inlineDiffPreview(tool({ id: "edit-preview", tool: "edit", metadata: { diff: "--- old\n+++ new\n-old line\n+new line" } }))).toEqual([
    "-old line",
    "+new line",
  ])
})

test("maps shell runs and shell tools that are not test commands", () => {
  const rows = sessionToolSteps([
    tool({ id: "shell-a", tool: "shell", input: { command: "pwd" } }),
    tool({ id: "test-b", tool: "bash", input: { command: "pnpm test" }, output: "2 failed", metadata: { exit: 1 } }),
  ])
  expect(rows).toMatchObject([
    { kind: "shell", partIDs: ["shell-a"], command: "pwd" },
    { kind: "test", partIDs: ["test-b"], command: "pnpm test", status: "failed", count: 2 },
  ])
})
