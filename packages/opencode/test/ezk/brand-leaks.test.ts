import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Installation } from "@/installation"

// Brand hygiene: strings that leave the machine or reach the user must say ezkielyna, not opencode. These are source-level checks
// on purpose: each of these call sites needs a network, a mDNS socket, an MCP server or a git repo to exercise for real.
const repo = path.resolve(import.meta.dir, "../../../..")
const src = (file: string) => readFileSync(path.join(repo, file), "utf8")

describe("brand leaks stay fixed", () => {
  test("the shared user agent is ezkielyna-agent", () => {
    expect(Installation.userAgent("websearch")).toStartWith("ezkielyna-agent/")
    expect(Installation.userAgent("websearch")).toEndWith("/websearch")
    expect(Installation.userAgent("websearch")).not.toContain("opencode")
  })

  test("web tools do not send an opencode user agent", () => {
    for (const file of [
      "packages/opencode/src/tool/websearch.ts",
      "packages/opencode/src/tool/webfetch.ts",
      "packages/core/src/tool/websearch.ts",
      "packages/core/src/tool/webfetch.ts",
    ]) {
      const text = src(file)
      expect({ file, leak: /["'`]opencode[/"'`]/.test(text) }).toEqual({ file, leak: false })
      expect({ file, branded: /ezkielyna-agent|Installation\.userAgent/.test(text) }).toEqual({ file, branded: true })
    }
  })

  test("mDNS announces ezkielyna.local and ezkielyna-<port>", () => {
    const text = src("packages/opencode/src/server/mdns.ts")
    expect(text).toContain('"ezkielyna.local"')
    expect(text).toContain("`ezkielyna-${port}`")
    expect(text).not.toContain("opencode")
  })

  test("mcp debug identifies as ezkielyna-debug", () => {
    const text = src("packages/opencode/src/cli/cmd/mcp.ts")
    expect(text).not.toContain("opencode-debug")
    expect(text.match(/"ezkielyna-debug"/g)?.length).toBe(2)
  })

  test("ACP terminal login runs the ezkielyna binary", () => {
    const text = src("packages/opencode/src/acp/service.ts")
    expect(text).toContain('command: "ezkielyna"')
    expect(text).not.toContain('command: "opencode"')
  })

  test("new worktree branches use the ezkielyna/ prefix", () => {
    const text = src("packages/opencode/src/worktree/index.ts")
    expect(text).toContain("`ezkielyna/${name}`")
    expect(text).not.toContain("`opencode/${name}`")
  })

  test("app fallback strings name ezkielyna.json", () => {
    expect(src("packages/app/src/utils/server-errors.ts")).not.toContain("opencode.json")
    expect(src("packages/app/src/components/status-popover-body.tsx")).not.toContain("opencode.json")
  })
})
