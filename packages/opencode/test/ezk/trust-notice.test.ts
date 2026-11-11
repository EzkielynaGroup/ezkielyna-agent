// B5: the one-line notice for `--permission-mode <m>` in a folder that is not trusted, and the `trust` help text.
import { describe, expect, test } from "bun:test"
import { modeIgnoredWhenUntrusted, requestedMode, untrustedModeNotice, warnUntrustedMode, warnUntrustedModeFlag } from "../../src/ezk/trust-notice"
import { TRUST_DESCRIBE } from "../../src/cli/cmd/ezkielyna-trust"

describe("trust notice (B5)", () => {
  test("English text names the mode and the fix", () => {
    expect(untrustedModeNotice("full", "en")).toBe("This folder is not trusted, so --permission-mode full is ignored. Run: ezkielyna trust")
  })

  test("Indonesian text", () => {
    expect(untrustedModeNotice("acceptEdits", "id")).toBe("Folder ini belum dipercaya, jadi --permission-mode acceptEdits diabaikan. Jalankan: ezkielyna trust")
  })

  test("only modes an untrusted folder would override count (ask and plan are not ignored)", () => {
    expect(modeIgnoredWhenUntrusted("full", false)).toBe(true)
    expect(modeIgnoredWhenUntrusted("acceptEdits", false)).toBe(true)
    expect(modeIgnoredWhenUntrusted("safeAuto", false)).toBe(true)
    expect(modeIgnoredWhenUntrusted("ask", false)).toBe(false)
    expect(modeIgnoredWhenUntrusted("plan", false)).toBe(false)
    expect(modeIgnoredWhenUntrusted("full", true)).toBe(false)
    expect(modeIgnoredWhenUntrusted(undefined, false)).toBe(false)
  })

  test("requestedMode accepts the same spellings as the flag", () => {
    expect(requestedMode("bypassPermissions")).toBe("full")
    expect(requestedMode("dontAsk")).toBe("ask")
    expect(requestedMode("auto")).toBe("safeAuto")
    expect(requestedMode("banana")).toBeUndefined()
    expect(requestedMode(undefined)).toBeUndefined()
  })

  test("warnUntrustedMode prints one line with the mode as typed, and nothing when trusted", () => {
    const lines: string[] = []
    expect(warnUntrustedMode({ mode: "full", raw: "bypassPermissions", trusted: false, log: (l) => lines.push(l), lang: "en" })).toBe(true)
    expect(lines).toEqual(["! This folder is not trusted, so --permission-mode bypassPermissions is ignored. Run: ezkielyna trust"])
    expect(warnUntrustedMode({ mode: "full", trusted: true, log: (l) => lines.push(l) })).toBe(false)
    expect(lines).toHaveLength(1)
  })

  test("the TUI flag helper writes one stderr line per untrusted non-ask mode and stays quiet otherwise", () => {
    const out: string[] = []
    const write = (text: string) => out.push(text)
    expect(warnUntrustedModeFlag({ value: "acceptEdits", trusted: false, write, lang: "en" })).toBe(true)
    expect(out).toEqual(["! This folder is not trusted, so --permission-mode acceptEdits is ignored. Run: ezkielyna trust\n"])
    expect(warnUntrustedModeFlag({ value: "acceptEdits", trusted: true, write })).toBe(false)
    expect(warnUntrustedModeFlag({ value: "ask", trusted: false, write })).toBe(false)
    expect(warnUntrustedModeFlag({ value: "plan", trusted: false, write })).toBe(false)
    expect(warnUntrustedModeFlag({ value: undefined, trusted: false, write })).toBe(false)
    expect(warnUntrustedModeFlag({ value: "", trusted: false, write })).toBe(false)
    expect(warnUntrustedModeFlag({ value: "banana", trusted: false, write })).toBe(false)
    expect(out).toHaveLength(1)
  })

  test("`trust` help says trust gates permission modes", () => {
    expect(TRUST_DESCRIBE).toMatch(/permission-mode/)
    expect(TRUST_DESCRIBE).toMatch(/only apply in trusted folders/)
  })
})
