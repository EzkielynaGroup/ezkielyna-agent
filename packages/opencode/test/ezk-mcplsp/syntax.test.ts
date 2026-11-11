import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { withTree } from "@opencode-ai/core/ezk/treesitter/loader"
import {
  checkSyntaxText,
  contextSnippet,
  installTip,
  resetTipsForTests,
  syntaxLangFor,
} from "../../src/ezk/codeintel/syntax"
import { SyntaxChecks } from "../../src/ezk/codeintel/post-edit"
import { Diagnostic } from "../../src/lsp/diagnostic"

// The grammars come from the shared loader (tree-sitter packages of @opencode-ai/core);
// skip the parsing tests where they are not installed.
const haveGrammars = (await withTree("typescript", "const a = 1", () => true).catch(() => undefined)) === true
const t = haveGrammars ? test : test.skip

const GOOD: Record<string, string> = {
  "a.ts": "export const f = (x: number): number => {\n  return x + 1\n}\n",
  "a.tsx": "export const A = () => <div className=\"x\">hi</div>\n",
  "a.js": "function f(a, b) {\n  return a + b\n}\nmodule.exports = f\n",
  "a.py": "def f(x):\n    return x + 1\n\nclass A:\n    pass\n",
  "a.go": "package main\n\nfunc main() {\n\tprintln(1)\n}\n",
  "a.rs": "fn main() {\n    let x = 1;\n    println!(\"{}\", x);\n}\n",
  "A.java": "class A {\n  int f(int x) {\n    return x + 1;\n  }\n}\n",
  "a.json": "{\n  \"enabled\": true,\n  \"count\": 3\n}\n",
  "a.yaml": "enabled: true\nitems:\n  - one\n  - two\n",
}
const BAD: Record<string, string> = {
  "a.ts": "export const f = (x: number): number => {\n  return x +\n\nconst y = 2\nfunction g( {\n",
  "a.js": "function f(a, b) {\n  return a + b\n\nmodule.exports = f\n",
  "a.py": "def f(x:\n    return x + 1\n\nclass A\n    pass\n",
  "a.go": "package main\n\nfunc main() {\n\tprintln(1\n}\n",
  "a.rs": "fn main() {\n    let x = ;\n    println!(\"{}\", x\n}\n",
  "A.java": "class A {\n  int f(int x) {\n    return x + ;\n  \n}\n",
  "a.json": "{\n  \"enabled\": true,\n  \"count\":\n}\n",
  "a.yaml": "enabled: [one, two\nitems:\n  - one\n",
}

describe("syntax check (tree-sitter)", () => {
  test("language map covers the shared loader's families only", () => {
    expect(syntaxLangFor("x/y.mts")).toBe("typescript")
    expect(syntaxLangFor("x/y.java")).toBe("java")
    expect(syntaxLangFor("x/y.d.ts")).toBeUndefined()
    expect(syntaxLangFor("x/y.yml")).toBe("yaml")
    expect(syntaxLangFor("x/y.json")).toBe("json")
    expect(syntaxLangFor("x/y.rb")).toBeUndefined()
    expect(syntaxLangFor("x/y.c")).toBeUndefined()
  })

  test("context snippet is the line plus one line on each side, error line marked", () => {
    const s = contextSnippet("a\nb\nc\nd\ne", 2)
    expect(s.split("\n")).toEqual(["  2 | b", "> 3 | c", "  4 | d"])
    expect(contextSnippet("only", 0)).toBe("> 1 | only")
  })

  for (const [file, text] of Object.entries(GOOD))
    t(`valid ${file} has no issues`, async () => {
      expect(await checkSyntaxText(file, text)).toEqual([])
    })

  for (const [file, text] of Object.entries(BAD))
    t(`broken ${file} reports ERROR with line context`, async () => {
      const diags = (await checkSyntaxText(file, text))!
      expect(diags.length).toBeGreaterThan(0)
      expect(diags.length).toBeLessThanOrEqual(5)
      const d = diags[0]!
      expect(d.severity).toBe(1)
      expect(d.message).toMatch(/^Syntax error/)
      expect(d.message).toContain("| ") // numbered context
      expect(d.message).toContain(">") // marked line
      // goes through the existing post-edit report unchanged
      const block = Diagnostic.report(file, diags as any)
      expect(block).toContain(`<diagnostics file="${file}">`)
      expect(block).toMatch(/ERROR \[\d+:\d+\] Syntax error/)
    })

  t("reports the right line for a missing brace", async () => {
    const d = (await checkSyntaxText("a.go", BAD["a.go"]!))!
    expect(d.some((x) => x.range.start.line + 1 >= 4 && x.range.start.line + 1 <= 5)).toBe(true)
  })

  test("unsupported extension and oversized text are skipped, not failed", async () => {
    expect(await checkSyntaxText("a.rb", "def (")).toBeUndefined()
    expect(await checkSyntaxText("a.js", "[" + "1,".repeat(300_000) + "1]")).toBeUndefined()
  })

  test("tip: one line, once per server, names no installer command", () => {
    resetTipsForTests()
    const tip = installTip("a.py")!
    expect(tip.split("\n").length).toBe(1)
    expect(tip).toContain("pyright")
    expect(tip).toContain("nothing is installed automatically")
    expect(installTip("b.py")).toBeUndefined()
    expect(installTip("a.json")).toBeUndefined() // no language server tip for JSON
  })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ezk-syntax-"))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  t("SyntaxChecks keeps results until the file changes, then drops them", async () => {
    resetTipsForTests()
    const file = path.join(dir, "bad.py")
    fs.writeFileSync(file, BAD["a.py"]!)
    const checks = new SyntaxChecks()
    const diags = await checks.check(file)
    expect(diags!.length).toBeGreaterThan(0)
    expect(diags![0]!.message).toContain("Tip:") // first time for python
    expect(checks.current().length).toBe(1)
    await Bun.sleep(20)
    fs.writeFileSync(file, GOOD["a.py"]!)
    expect(checks.current().length).toBe(0)
    // a clean re-check clears too
    fs.writeFileSync(file, BAD["a.py"]!)
    await checks.check(file)
    fs.writeFileSync(file, GOOD["a.py"]!)
    await checks.check(file)
    expect(checks.current().length).toBe(0)
  })
})
