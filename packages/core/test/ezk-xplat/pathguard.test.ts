import { describe, expect, test } from "bun:test"
import path from "node:path"
import { findEscape, isInside, pathTokens } from "../../src/ezk/telegram/pathguard"

describe("Telegram path guard on Windows paths", () => {
  const root = "C:\\Users\\owner\\workspace"

  test("contains drive paths with mixed separators and rejects traversal", () => {
    expect(isInside(root, "C:/Users/owner/workspace/src/file.ts", path.win32)).toBe(true)
    expect(isInside(root, "C:\\Users\\owner\\workspace\\..\\secrets.txt", path.win32)).toBe(false)
  })

  test("finds drive-letter paths in shell commands", () => {
    expect(pathTokens('type C:\\Users\\owner\\secret.txt')).toEqual(["C:\\Users\\owner\\secret.txt"])
    expect(findEscape(root, 'type C:\\Users\\owner\\secret.txt', path.win32)).toBe("C:\\Users\\owner\\secret.txt")
    expect(findEscape(root, 'type C:/Users/owner/workspace/src/file.ts', path.win32)).toBeUndefined()
  })

  test("finds UNC paths in shell commands", () => {
    expect(pathTokens('copy \\\\server\\share\\secret.txt .')).toEqual(["\\\\server\\share\\secret.txt"])
    expect(findEscape(root, 'copy \\\\server\\share\\secret.txt .', path.win32)).toBe("\\\\server\\share\\secret.txt")
  })
})
