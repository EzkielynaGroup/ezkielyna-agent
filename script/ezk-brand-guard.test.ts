import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkLine, isUserVisibleBrand, main, parseAllowlist, scan } from "./ezk-brand-guard"

describe("isUserVisibleBrand", () => {
  test.each([
    'import { x } from "@opencode-ai/core/foo"',
    "const k = process.env.OPENCODE_CONFIG",
    'const dir = ".opencode/agent"',
    '"$schema": "https://opencode.ai/config.json"',
    'storage.getItem("opencode.global.dat")',
    "export class OpenCodeHttpApi {}",
    '"wsl.onboarding.step.opencode": "Ezkielyna Agent"',
    "return ProviderV2.ID.opencode",
    "const a = `opencode/${InstallationVersion}`",
    "`~/.config/opencode/opencode.json`",
  ])("internal identifier is not flagged: %s", (line) => {
    expect(isUserVisibleBrand(line)).toBe(false)
  })

  test.each([
    'title: "Welcome to OpenCode"',
    'console.log("run opencode to start")',
    'href="https://opencode.ai/docs"',
    'link: "https://opncd.ai/s/abc"',
    "see https://github.com/anomalyco/opencode/issues/1",
    '"desktop.menu.app": "OpenCode"',
    "Try: `opencode models` to list models",
    '"Based on OpenCode" and @opencode-ai/core',
  ])("user-visible text is flagged: %s", (line) => {
    expect(isUserVisibleBrand(line)).toBe(true)
  })
})

describe("checkLine", () => {
  const none = parseAllowlist("")

  test("flags a new brand string and ignores comments and imports", () => {
    expect(checkLine("packages/x/src/a.ts", 3, 'toast("OpenCode failed")', none)?.kind).toBe("brand")
    expect(checkLine("packages/x/src/a.ts", 3, "// OpenCode upstream note", none)).toBeUndefined()
    expect(checkLine("packages/x/src/a.ts", 3, 'import a from "../opencode/thing"', none)).toBeUndefined()
  })

  test("markdown prose is checked even when it starts with a list marker or heading", () => {
    expect(checkLine("packages/x/src/a.md", 1, "# OpenCode guide", none)?.kind).toBe("brand")
  })

  test.each(["ExampleVendor", "Partner", "Mac upstream", "the upstream is Mac"])(
    "supplier name %s is always a violation, even when allowlisted",
    (name) => {
      const line = `label: "${name}"`
      const allow = parseAllowlist("packages/x/src/**:re:.")
      expect(checkLine("packages/x/src/a.ts", 1, line, allow)?.kind).toBe("supplier")
    },
  )

  test("ordinary words and macOS are not suppliers", () => {
    expect(checkLine("packages/x/src/a.ts", 1, 'label: "partner link, macOS and Mac keys"', none)).toBeUndefined()
  })
})

describe("allowlist", () => {
  test("matches by path glob and literal or regex pattern", () => {
    const allow = parseAllowlist(
      ["# comment", "", "packages/x/src/a.ts:OpenCode (MIT)", "packages/y/src/**:re:^foo.*OpenCode"].join("\n"),
    )
    const line = 'copyright: "Based on OpenCode (MIT)"'
    expect(checkLine("packages/x/src/a.ts", 1, line, allow)).toBeUndefined()
    expect(checkLine("packages/x/src/b.ts", 1, line, allow)?.kind).toBe("brand")
    expect(checkLine("packages/y/src/deep/c.ts", 1, 'foo("OpenCode")', allow)).toBeUndefined()
    expect(checkLine("packages/y/src/deep/c.ts", 1, 'bar("OpenCode")', allow)?.kind).toBe("brand")
  })

  test("rejects malformed lines", () => {
    expect(() => parseAllowlist("no-pattern-here")).toThrow()
    expect(() => parseAllowlist("path-only:")).toThrow()
  })
})

describe("scan / main", () => {
  const make = (files: Record<string, string>, allow = "") => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-brand-guard-"))
    for (const [file, body] of Object.entries({ ...files, "script/ezk-brand-allowlist.txt": allow })) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
      fs.writeFileSync(path.join(root, file), body)
    }
    return root
  }

  test("clean tree passes, tests and non-src dirs are skipped", () => {
    const root = make({
      "packages/a/src/ok.ts": 'import x from "@opencode-ai/core/x"\nconst t = "Ezkielyna Agent"\n',
      "packages/a/src/ok.test.ts": 'expect("OpenCode").toBe("OpenCode")\n',
      "packages/a/test/t.ts": 'const s = "OpenCode"\n',
      "packages/a/docs/readme.md": "OpenCode\n",
    })
    expect(scan(root, [])).toEqual([])
    expect(main(root)).toBe(0)
  })

  test("a new user-visible string fails, and the allowlist can clear it", () => {
    const files = { "packages/a/src/ui.tsx": 'export const t = "Welcome to OpenCode"\n' }
    const failing = make(files)
    expect(scan(failing, [])).toEqual([expect.objectContaining({ file: "packages/a/src/ui.tsx", line: 1, kind: "brand" })])
    expect(main(failing)).toBe(1)
    expect(main(make(files, "packages/a/src/ui.tsx:Welcome to OpenCode\n"))).toBe(0)
  })

  test("supplier names in locale files fail the run", () => {
    const root = make({ "packages/app/src/i18n/xx.ts": '  "k": "Powered by ExampleVendor",\n' }, "packages/app/src/i18n/*.ts:re:.\n")
    expect(main(root)).toBe(1)
  })
})
