import { describe, expect, test } from "bun:test"
import { headTailPreview, formatOmittedBytes, estimateTokenCount } from "../../src/ezk/tools/output"
import { preferredEditTool, shouldExposeEditTool } from "../../src/ezk/tools/edit-preference"
import { closestWindows, editMatchFailure } from "../../src/ezk/tools/edit-recovery"
import { EditFixCache, validateCorrection } from "../../src/ezk/tools/edit-fixer"

describe("Wave A tool helpers", () => {
  test("head-tail truncation reports omitted UTF-8 bytes and keeps both edges", () => {
    const value = `start${"💾".repeat(1000)}end`
    const preview = headTailPreview(value, 20)
    expect(preview.head.startsWith("start")).toBe(true)
    expect(preview.tail.endsWith("end")).toBe(true)
    expect(preview.omittedBytes).toBe(Buffer.byteLength(value) - Buffer.byteLength(preview.head) - Buffer.byteLength(preview.tail))
    expect(formatOmittedBytes(preview.head, preview.tail, preview.omittedBytes)).toContain(`… ${preview.omittedBytes} bytes omitted …`)
  })

  test("the text budget estimate counts punctuation and non-ASCII text conservatively", () => {
    expect(estimateTokenCount("hello world")).toBe(4)
    expect(estimateTokenCount("你好")).toBe(2)
    expect(estimateTokenCount("a!!!")).toBe(4)
  })

  test("selection keeps the replay winner while opt-in makes patch available to every family", () => {
    expect(preferredEditTool("gpt-5.2")).toBe("apply_patch")
    expect(preferredEditTool("claude-sonnet")).toBe("edit")
    expect(preferredEditTool("gpt-4o")).toBe("edit")
    expect(preferredEditTool("gemini-flash")).toBe("edit")
    for (const model of ["gpt-5.2", "claude-sonnet", "gemini-flash", "deepseek-chat"]) {
      expect(shouldExposeEditTool(model, "apply_patch", true)).toBe(true)
      expect(shouldExposeEditTool(model, "edit", true)).toBe(true)
    }
  })

  test("edit recovery returns the three closest line-numbered windows and exact retry rule", () => {
    const content = ["intro", "function alpha() {", " return 1", "}", "middle", "function beta() {", " return 2", "}", "end"].join("\n")
    expect(closestWindows(content, "function beta() {\n return 9")).toHaveLength(3)
    const message = editMatchFailure(content, "function beta() {\n return 9", "Could not find oldString")
    expect(message).toContain("lines 6-7")
    expect(message).toContain("re-read the file, then retry with the exact text")
  })

  test("edit fixer accepts only a unique exact search string and the LRU stays bounded", () => {
    expect(validateCorrection('{"oldString":"const value = 1"}', "const value=1", "const value = 1\n")).toBe("const value = 1")
    expect(validateCorrection('{"oldString":"x"}', "z", "x\nx\n")).toBeUndefined()
    expect(validateCorrection("not json", "z", "x\n")).toBeUndefined()
    const cache = new EditFixCache(50)
    for (let i = 0; i < 60; i++) cache.set(String(i), String(i))
    expect(cache.size).toBe(50)
    expect(cache.get("0")).toBeUndefined()
    expect(cache.get("59")).toBe("59")
  })
})
