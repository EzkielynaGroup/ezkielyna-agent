import { describe, expect, test } from "bun:test"
import nodePath from "node:path"
import {
  type FsLike,
  discoverInstructions,
  globToRegExp,
  matchesAny,
  parseFrontMatter,
  rulesForFile,
  stripHtmlComments,
} from "../../src/ezk/context/instructions"

function memFs(files: Record<string, string>, links: Record<string, string> = {}): FsLike {
  return {
    read: (f) => files[f],
    list: (d) => {
      const prefix = d.endsWith("/") || d.endsWith("\\") ? d : d + (d.includes("\\") ? "\\" : "/")
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix) && !/[\\/]/.test(k.slice(prefix.length)))
        .map((k) => k.slice(prefix.length))
    },
    real: (f) => links[f] ?? f,
  }
}

const base = { root: "/p", cwd: "/p/a/b", userDir: "/u/ezk", home: "/u", trusted: true }
const texts = (r: { parts: string[] }) => r.parts.join("\n")

describe("C1 instruction hierarchy", () => {
  test("order: user, then root down to cwd, then local overrides", () => {
    const fs = memFs({
      "/u/ezk/AGENTS.md": "USER",
      "/p/AGENTS.md": "ROOT",
      "/p/a/AGENTS.md": "MID",
      "/p/a/b/AGENTS.md": "CWD",
      "/p/AGENTS.local.md": "LOCAL",
    })
    const r = discoverInstructions({ ...base, fs, path: nodePath.posix })
    expect(r.files.map((f) => f.content)).toEqual(["USER", "ROOT", "MID", "CWD", "LOCAL"])
    expect(r.files.map((f) => f.scope)).toEqual(["user", "project", "project", "project", "local"])
  })

  test("reads both AGENTS.md and CLAUDE.md; identical content is read once", () => {
    const fs = memFs({ "/p/AGENTS.md": "A", "/p/CLAUDE.md": "C", "/p/a/AGENTS.md": "same", "/p/a/CLAUDE.md": "same" })
    const r = discoverInstructions({ ...base, cwd: "/p/a", fs, path: nodePath.posix })
    expect(r.files.map((f) => f.content)).toEqual(["A", "C", "same"])
  })

  test("AGENTS.override.md wins in its folder only", () => {
    const fs = memFs({
      "/p/AGENTS.md": "root",
      "/p/CLAUDE.md": "root-claude",
      "/p/a/AGENTS.override.md": "override",
      "/p/a/AGENTS.md": "ignored",
      "/p/a/CLAUDE.md": "ignored too",
    })
    const r = discoverInstructions({ ...base, cwd: "/p/a", fs, path: nodePath.posix })
    expect(r.files.map((f) => f.content)).toEqual(["root", "root-claude", "override"])
  })

  test("@imports are inlined, depth max 4, cycles ignored", () => {
    const fs = memFs({
      "/p/AGENTS.md": "top @docs/one.md",
      "/p/docs/one.md": "L1 @two.md",
      "/p/docs/two.md": "L2 @three.md",
      "/p/docs/three.md": "L3 @four.md",
      "/p/docs/four.md": "L4 @five.md",
      "/p/docs/five.md": "L5 should not load",
    })
    const out = texts(discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix }))
    expect(out).toContain("L4")
    expect(out).not.toContain("L5 should not load")
    const cyc = memFs({ "/p/AGENTS.md": "a @x.md", "/p/x.md": "x @AGENTS.md" })
    const c = texts(discoverInstructions({ ...base, cwd: "/p", fs: cyc, path: nodePath.posix }))
    expect(c.match(/x @AGENTS.md/g)?.length).toBe(1)
  })

  test("@imports never leave the project or the user config dir", () => {
    const fs = memFs({
      "/p/AGENTS.md": "see @../secret.md and @/etc/passwd and @~/.ssh/id and @../u/ezk/notes.md ok @/u/ezk/notes.md",
      "/secret.md": "SECRET",
      "/etc/passwd": "ROOT:x",
      "/u/.ssh/id": "KEY",
      "/u/ezk/notes.md": "NOTES",
    })
    const out = texts(discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix }))
    expect(out).not.toContain("SECRET")
    expect(out).not.toContain("ROOT:x")
    expect(out).not.toContain("KEY")
    expect(out).not.toContain("NOTES") // M9: project files may no longer import from the user config dir
  })

  test("a symlink that points outside is refused", () => {
    const fs = memFs({ "/p/AGENTS.md": "x @link.md", "/p/link.md": "LEAK", "/outside/real.md": "LEAK" }, { "/p/link.md": "/outside/real.md" })
    expect(texts(discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix }))).not.toContain("[imported")
  })

  test("user files may not import project files", () => {
    const fs = memFs({ "/u/ezk/AGENTS.md": "u @../../p/x.md", "/p/x.md": "PROJ" })
    expect(texts(discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix }))).not.toContain("PROJ")
  })

  test("@mentions, emails and code are not imports", () => {
    const fs = memFs({ "/p/AGENTS.md": "ask @bob or me@x.dev\n`@a/b.md`\n```\n@a/b.md\n```", "/p/a/b.md": "BODY" })
    expect(texts(discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix }))).not.toContain("BODY")
  })

  test("rules/*.md: without paths always on, with paths only when a matching file is in play", () => {
    const fs = memFs({
      "/p/.ezkielyna/rules/always.md": "ALWAYS",
      "/p/.claude/rules/ts.md": "---\npaths: [\"src/**/*.ts\", \"*.tsx\"]\n---\nTS RULE",
      "/p/.claude/rules/py.md": "---\npaths:\n  - 'py/**'\n---\nPY RULE",
    })
    const o = { ...base, cwd: "/p", fs, path: nodePath.posix }
    const sys = texts(discoverInstructions(o))
    expect(sys).toContain("ALWAYS")
    expect(sys).not.toContain("TS RULE")
    expect(rulesForFile(o, "/p/src/deep/x.ts").map((f) => f.content)).toEqual(["TS RULE"])
    expect(rulesForFile(o, "src/x.tsx").map((f) => f.content)).toEqual(["TS RULE"])
    expect(rulesForFile(o, "/p/py/a/b.py").map((f) => f.content)).toEqual(["PY RULE"])
    expect(rulesForFile(o, "/p/README.md")).toEqual([])
    expect(rulesForFile(o, "/elsewhere/x.ts")).toEqual([])
  })

  test("HTML comments are stripped, code fences kept", () => {
    expect(stripHtmlComments("a <!-- note\nmore --> b\n```\n<!-- keep -->\n```")).toBe("a  b\n```\n<!-- keep -->\n```")
    const fs = memFs({ "/p/AGENTS.md": "hello <!-- maintainers only --> world" })
    expect(texts(discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix }))).not.toContain("maintainers")
  })

  test("32 KiB cap with a visible truncated note", () => {
    const fs = memFs({ "/p/AGENTS.md": "x".repeat(20_000), "/p/a/AGENTS.md": "y".repeat(20_000), "/p/a/b/AGENTS.md": "z".repeat(100) })
    const r = discoverInstructions({ ...base, fs, path: nodePath.posix })
    const bytes = new TextEncoder().encode(texts(r)).length
    expect(r.truncated).toBe(true)
    expect(bytes).toBeLessThanOrEqual(32 * 1024 + 400)
    expect(r.parts.at(-1)).toContain("truncated at 32 KiB")
    expect(texts(r)).not.toContain("zzz")
    const small = discoverInstructions({ ...base, fs: memFs({ "/p/AGENTS.md": "ok" }), path: nodePath.posix })
    expect(small.truncated).toBe(false)
  })

  test("untrusted folder: every project-level file is skipped, user files stay", () => {
    const fs = memFs({
      "/u/ezk/AGENTS.md": "USER",
      "/p/AGENTS.md": "ROOT",
      "/p/CLAUDE.md": "ROOTC",
      "/p/AGENTS.local.md": "LOCAL",
      "/p/.claude/rules/r.md": "RULE",
      "/p/.claude/rules/s.md": "---\npaths: src/*\n---\nSCOPED",
    })
    const o = { ...base, cwd: "/p", trusted: false, fs, path: nodePath.posix }
    const r = discoverInstructions(o)
    expect(r.files.map((f) => f.content)).toEqual(["USER"])
    expect(r.skippedUntrusted).toBe(true)
    expect(rulesForFile(o, "/p/src/a")).toEqual([])
  })

  test("user rules and ~/.claude/CLAUDE.md load", () => {
    const fs = memFs({ "/u/.claude/CLAUDE.md": "CLAUDE-HOME", "/u/ezk/rules/r.md": "URULE" })
    const r = discoverInstructions({ ...base, cwd: "/p", fs, path: nodePath.posix })
    expect(r.files.map((f) => f.content)).toEqual(["CLAUDE-HOME", "URULE"])
  })

  test("cwd outside the root reads only the cwd folder", () => {
    const fs = memFs({ "/p/AGENTS.md": "ROOT", "/other/AGENTS.md": "OTHER" })
    const r = discoverInstructions({ ...base, cwd: "/other", fs, path: nodePath.posix })
    expect(r.files.map((f) => f.content)).toEqual(["OTHER"])
  })
})

describe("C1 on Windows paths", () => {
  const W = nodePath.win32
  const wbase = { root: "C:\\proj", cwd: "C:\\proj\\pkg\\web", userDir: "C:\\Users\\me\\.config\\ezkielyna", home: "C:\\Users\\me", trusted: true }

  test("hierarchy, override and imports with backslashes", () => {
    const fs = memFs({
      "C:\\Users\\me\\.config\\ezkielyna\\AGENTS.md": "USER",
      "C:\\proj\\AGENTS.md": "ROOT @docs\\a.md",
      "C:\\proj\\docs\\a.md": "IMPORTED",
      "C:\\proj\\pkg\\web\\AGENTS.override.md": "OVERRIDE",
      "C:\\proj\\pkg\\web\\AGENTS.md": "IGNORED",
    })
    const r = discoverInstructions({ ...wbase, fs, path: W })
    expect(r.files.map((f) => f.content.split("\n")[0])).toEqual(["USER", "ROOT docs\\a.md", "OVERRIDE"])
    expect(texts(r)).toContain("IMPORTED")
  })

  test("imports cannot escape to another drive or parent", () => {
    const fs = memFs({
      "C:\\proj\\AGENTS.md": "a @D:\\x.md b @..\\secret.md",
      "D:\\x.md": "DRIVE",
      "C:\\secret.md": "PARENT",
    })
    const out = texts(discoverInstructions({ ...wbase, cwd: "C:\\proj", fs, path: W }))
    expect(out).not.toContain("DRIVE")
    expect(out).not.toContain("PARENT")
  })

  test("path-scoped rules match Windows paths and mixed separators", () => {
    const fs = memFs({ "C:\\proj\\.claude\\rules\\ts.md": "---\npaths: src/**/*.ts\n---\nTS" })
    const o = { ...wbase, cwd: "C:\\proj", fs, path: W }
    expect(rulesForFile(o, "C:\\proj\\src\\a\\b.ts").length).toBe(1)
    expect(rulesForFile(o, "c:\\PROJ\\src/b.ts").length).toBe(1)
    expect(rulesForFile(o, "C:\\proj\\lib\\b.ts").length).toBe(0)
  })

  test("untrusted Windows folder skips project files", () => {
    const fs = memFs({ "C:\\proj\\AGENTS.md": "ROOT", "C:\\Users\\me\\.config\\ezkielyna\\AGENTS.md": "USER" })
    const r = discoverInstructions({ ...wbase, cwd: "C:\\proj", trusted: false, fs, path: W })
    expect(r.files.map((f) => f.content)).toEqual(["USER"])
  })
})

describe("glob and front-matter helpers", () => {
  test("globs", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true)
    expect(globToRegExp("src/**/*.ts").test("src/c.ts")).toBe(true)
    expect(globToRegExp("*.md").test("docs/x.md")).toBe(true) // no slash: any depth
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false)
    expect(matchesAny(["**/*.{ts,tsx}"], "a\\b\\c.tsx")).toBe(true)
    expect(matchesAny(["a?.js"], "ab.js")).toBe(true)
  })
  test("front-matter forms", () => {
    expect(parseFrontMatter("---\npaths: a/**, b/*.ts\n---\nbody").paths).toEqual(["a/**", "b/*.ts"])
    expect(parseFrontMatter("no front matter").paths).toBeUndefined()
    expect(parseFrontMatter("---\nname: x\n---\nb").paths).toBeUndefined()
  })
})

describe("M9 import restrictions", () => {
  const imp = (files: Record<string, string>, links: Record<string, string> = {}) => texts(discoverInstructions({ ...base, fs: memFs(files, links) }))
  test("secret, protected and non-text files are not inlined", () => {
    const out = imp({
      "/p/AGENTS.md": "a @.env b @.git/config c @.ezkielyna/settings.json d @src/key.pem e @a.json f @/u/ezk/ezkielyna.jsonc g @docs/ok.md",
      "/p/.env": "SECRET1",
      "/p/.git/config": "SECRET2",
      "/p/.ezkielyna/settings.json": "SECRET3",
      "/p/src/key.pem": "SECRET4",
      "/p/a.json": "SECRET5",
      "/u/ezk/ezkielyna.jsonc": "SECRET6",
      "/p/docs/ok.md": "OKDOC",
    })
    expect(out).not.toMatch(/SECRET/)
    expect(out).toContain("OKDOC")
  })
  test("project instructions cannot import from the user dir", () => {
    expect(imp({ "/p/AGENTS.md": "x @/u/ezk/notes.md", "/u/ezk/notes.md": "USERNOTE" })).not.toContain("USERNOTE")
  })
  test("a symlink to a protected file is refused", () => {
    expect(imp({ "/p/AGENTS.md": "x @notes.md", "/p/notes.md": "LEAK", "/p/.env": "LEAK" }, { "/p/notes.md": "/p/.env" })).not.toContain("LEAK")
  })
  test("symlinked AGENTS.md pointing outside is not read", () => {
    expect(imp({ "/p/AGENTS.md": "LEAK", "/outside/x.md": "LEAK" }, { "/p/AGENTS.md": "/outside/x.md" })).not.toContain("LEAK")
  })
  test("fan-out is capped by total imported bytes", () => {
    const big = "y".repeat(20000)
    const out = imp({ "/p/AGENTS.md": Array.from({ length: 50 }, () => "@big.md").join("\n"), "/p/big.md": big })
    expect((out.match(/y{100}/g) ?? []).length).toBeLessThan(400)
    expect(out.length).toBeLessThan(40000)
  })
})
