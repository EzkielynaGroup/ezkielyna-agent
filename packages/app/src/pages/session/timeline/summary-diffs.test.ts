import { describe, expect, test } from "bun:test"
import type { Part, SnapshotFileDiff } from "@opencode-ai/sdk/v2"
import { turnSummaryDiffs, uniqueSummaryDiffs } from "./summary-diffs"

const diff = (file: string, additions: number) =>
  ({
    file,
    additions,
    deletions: 0,
  }) satisfies SnapshotFileDiff

describe("uniqueSummaryDiffs", () => {
  test("drops entries without files and preserves unique input", () => {
    const alpha = diff("alpha.ts", 1)
    const beta = diff("beta.ts", 1)
    const invalid = { additions: 1, deletions: 0 } satisfies SnapshotFileDiff

    expect(uniqueSummaryDiffs(undefined)).toEqual([])
    expect(uniqueSummaryDiffs([])).toEqual([])
    expect(uniqueSummaryDiffs([invalid])).toEqual([])

    const result = uniqueSummaryDiffs([alpha, invalid, beta])
    expect(result).toEqual([alpha, beta])
    expect(result[0]).toBe(alpha)
    expect(result[1]).toBe(beta)
  })

  test("keeps the last diff per file in the legacy display order", () => {
    const oldAlpha = diff("alpha.ts", 1)
    const oldBeta = diff("beta.ts", 1)
    const newAlpha = diff("alpha.ts", 2)
    const charlie = diff("charlie.ts", 1)
    const newBeta = diff("beta.ts", 2)

    const result = uniqueSummaryDiffs([oldAlpha, oldBeta, newAlpha, charlie, newBeta])

    expect(result).toEqual([newAlpha, charlie, newBeta])
    expect(result[0]).toBe(newAlpha)
    expect(result[1]).toBe(charlie)
    expect(result[2]).toBe(newBeta)
  })
})

describe("turnSummaryDiffs", () => {
  test("uses completed edit metadata when the user summary has no file list", () => {
    const part = {
      id: "edit-1",
      sessionID: "session-1",
      messageID: "assistant-1",
      type: "tool",
      callID: "call-1",
      tool: "edit",
      state: {
        status: "completed",
        input: { filePath: "src/checkout.ts" },
        output: "Edited checkout",
        title: "checkout.ts",
        metadata: {
          filediff: { file: "src/checkout.ts", additions: 2, deletions: 1, patch: "@@" },
        },
        time: { start: 1, end: 2 },
      },
    } satisfies Part

    expect(turnSummaryDiffs(undefined, [part])).toEqual([
      { file: "src/checkout.ts", additions: 2, deletions: 1, patch: "@@" },
    ])
  })

  test("collects patch metadata from completed apply_patch tools", () => {
    const part = {
      id: "patch-1",
      sessionID: "session-1",
      messageID: "assistant-1",
      type: "tool",
      callID: "call-patch-1",
      tool: "apply_patch",
      state: {
        status: "completed",
        input: {},
        output: "Updated files",
        title: "apply_patch",
        metadata: {
          files: [
            { relativePath: "src/one.ts", type: "edit", additions: 3, deletions: 1, patch: "@@ one" },
            { relativePath: "src/new.ts", type: "add", additions: 5, deletions: 0, patch: "@@ new" },
          ],
        },
        time: { start: 1, end: 2 },
      },
    } satisfies Part

    expect(turnSummaryDiffs(undefined, [part])).toEqual([
      { file: "src/one.ts", additions: 3, deletions: 1, patch: "@@ one" },
      { file: "src/new.ts", additions: 5, deletions: 0, patch: "@@ new", status: "added" },
    ])
  })

  test("prefers the explicit user summary for duplicate files and ignores running edits", () => {
    const running = {
      id: "edit-2",
      sessionID: "session-1",
      messageID: "assistant-1",
      type: "tool",
      callID: "call-2",
      tool: "edit",
      state: {
        status: "running",
        input: { filePath: "src/checkout.ts" },
        metadata: { filediff: { file: "src/checkout.ts", additions: 99, deletions: 0 } },
        time: { start: 1 },
      },
    } satisfies Part
    const summary = diff("src/checkout.ts", 4)

    expect(turnSummaryDiffs([summary], [running])).toEqual([summary])
  })
})
