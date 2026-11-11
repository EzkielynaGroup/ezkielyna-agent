import { describe, expect, test } from "bun:test"
import { stopProcessTree } from "../../src/ezk/process-tree"

describe("cross-platform child process cleanup", () => {
  test("uses taskkill tree mode on Windows", () => {
    const commands: string[][] = []
    const signals: string[] = []

    stopProcessTree(
      { pid: 456, kill: (signal) => (signals.push(signal ?? ""), true) },
      "win32",
      (args) => (commands.push(args), { status: 0 }),
    )

    expect(commands).toEqual([["/PID", "456", "/T", "/F"]])
    expect(signals).toEqual([])
  })

  test("falls back to the child signal when taskkill fails", () => {
    const signals: string[] = []
    stopProcessTree({ pid: 456, kill: (signal) => (signals.push(signal ?? ""), true) }, "win32", () => ({ status: 1 }))
    expect(signals).toEqual(["SIGTERM"])
  })

  test("uses SIGTERM on Unix platforms without invoking taskkill", () => {
    const signals: string[] = []
    stopProcessTree({ pid: 456, kill: (signal) => (signals.push(signal ?? ""), true) }, "linux", () => {
      throw new Error("taskkill must not run on Linux")
    })
    expect(signals).toEqual(["SIGTERM"])
  })
})
