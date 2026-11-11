// P3: no ANSI escape codes unless a person is looking at a terminal (and never with NO_COLOR).
import { describe, expect, test } from "bun:test"
import { Style, colorEnabled } from "../../src/cli/ui"

const both = { stdout: true, stderr: true }

describe("colorEnabled", () => {
  test("terminals on both streams get colour", () => expect(colorEnabled({}, both)).toBe(true))

  test("a pipe or a redirected stream means plain text", () => {
    expect(colorEnabled({}, { stdout: false, stderr: true })).toBe(false)
    expect(colorEnabled({}, { stdout: true, stderr: false })).toBe(false)
    expect(colorEnabled({}, {})).toBe(false)
  })

  test("NO_COLOR (any non-empty value) wins over a terminal and over FORCE_COLOR", () => {
    expect(colorEnabled({ NO_COLOR: "1" }, both)).toBe(false)
    expect(colorEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, both)).toBe(false)
    expect(colorEnabled({ NO_COLOR: "" }, both)).toBe(true) // an empty value does not count (no-color.org)
  })

  test("FORCE_COLOR turns colour on for a pipe; 0 and false do not", () => {
    expect(colorEnabled({ FORCE_COLOR: "1" }, {})).toBe(true)
    expect(colorEnabled({ FORCE_COLOR: "0" }, {})).toBe(false)
    expect(colorEnabled({ FORCE_COLOR: "false" }, {})).toBe(false)
  })
})

describe("Style under test (stdout is a pipe here)", () => {
  test("every style is an empty string, so nothing prints escape codes", () => {
    for (const value of Object.values(Style)) expect(value).toBe("")
    expect(Object.keys(Style).length).toBeGreaterThan(10)
  })
})
