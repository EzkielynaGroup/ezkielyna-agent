// One protected-paths list (review H1/H2/M5): tools, permission modes and the sandbox share it; a remembered rule never opens it.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decide, type DecideInput } from "../../src/ezk/safety/decide"
import {
  PROTECTED_DIRS,
  PROTECTED_FILES,
  SANDBOX_READONLY_NAMES,
  isProtectedPath,
  isProtectedRelative,
  protectedPathMentions,
  protectedRoot,
} from "../../src/ezk/safety/protected-paths"
import { parseRule } from "../../src/ezk/safety/rules"
import { PROTECTED_NAMES } from "../../src/ezk/sandbox"

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-protected-")))
const root = path.join(base, "project")
fs.mkdirSync(path.join(root, "src"), { recursive: true })
fs.mkdirSync(path.join(root, ".git", "hooks"), { recursive: true })
fs.symlinkSync(path.join(root, ".git"), path.join(root, "docs"))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

describe("one protected-paths list", () => {
  test("the sandbox keeps exactly the shared list's code-execution names read-only", () => {
    expect([...PROTECTED_NAMES]).toEqual([...SANDBOX_READONLY_NAMES])
    for (const name of SANDBOX_READONLY_NAMES) expect(PROTECTED_DIRS.has(name) || PROTECTED_FILES.has(name)).toBe(true)
  })

  test.each([
    ".git/hooks/pre-commit",
    ".ezkielyna/settings.json",
    ".claude/settings.json",
    ".husky/pre-commit",
    ".vscode/tasks.json",
    "ezkielyna.json",
    "ezkielyna.jsonc",
    "opencode.json",
    "opencode.jsonc",
    ".opencode/agent/x.md",
    ".mcp.json",
    ".github/workflows/ci.yml",
    "AGENTS.md",
    "packages/a/CLAUDE.md",
    ".env",
    "config/.env.local",
    ".GIT/hooks/pre-commit",
    "Ezkielyna.JSONC",
  ])("%s is protected (case-insensitive, any depth)", (rel) => {
    expect(isProtectedRelative(rel)).toBe(true)
  })

  test.each(["src/index.ts", ".env.example", ".github/ISSUE_TEMPLATE/bug.md", "docs/readme.md", "src/.gitkeep", "notes/agents.mdx"])(
    "%s is not protected",
    (rel) => expect(isProtectedRelative(rel)).toBe(false),
  )

  test("paths are measured from the worktree root and through symlinks", () => {
    expect(isProtectedPath(root, path.join(root, "src", "..", ".git", "config"))).toBe(true)
    expect(isProtectedPath(root, path.join(root, "docs", "hooks", "pre-commit"))).toBe(true) // docs -> .git
    expect(isProtectedPath(root, path.join(root, "src", "a.ts"))).toBe(false)
    expect(protectedRoot({ directory: path.join(root, "packages", "a"), worktree: root })).toBe(root)
    expect(protectedRoot({ directory: root, worktree: "/" })).toBe(root)
    // a sub-folder opened inside a repo: the repo's .git is still protected when measured from the worktree root
    expect(isProtectedPath(protectedRoot({ directory: path.join(root, "packages", "a"), worktree: root }), path.join(root, ".git", "hooks", "x"))).toBe(true)
  })

  test("shell mentions", () => {
    const m = (cmd: string) => protectedPathMentions(root, root, cmd, "posix")
    expect(m("echo x > ezkielyna.jsonc")).toBe(true)
    expect(m("cp a .github/workflows/ci.yml")).toBe(true)
    expect(m(`python3 -c "open('AGENTS.md','a')"`)).toBe(true)
    expect(m("cat .env")).toBe(true)
    expect(m("cat .env.example")).toBe(false)
    expect(m("ls src && bun test")).toBe(false)
  })
})

describe("a remembered rule or a mode never opens a protected path (H1)", () => {
  const rules = [parseRule("Edit", "allow", "test")!]
  const run = (mode: DecideInput["mode"], pattern: string, ruleList = rules) =>
    decide({
      mode,
      trusted: true,
      permission: "edit",
      pattern,
      base: { action: "ask", fromDefaults: true },
      rules: ruleList,
      root,
      worktree: root,
      flags: { modes: true, rules: true },
    }).action

  test.each([".git/hooks/pre-commit", ".ezkielyna/settings.json", ".husky/pre-commit", "ezkielyna.jsonc", ".GIT/hooks/x", ".github/workflows/ci.yml", "docs/hooks/pre-commit", "AGENTS.md"])(
    "bare Edit rule + Edit otomatis still asks for %s",
    (file) => {
      expect(run("acceptEdits", file)).toBe("ask")
      expect(run("safeAuto", file)).toBe("ask")
      expect(run("ask", file)).toBe("ask")
    },
  )

  test("normal files stay allowed", () => {
    expect(run("acceptEdits", "src/a.ts")).toBe("allow")
    expect(run("ask", "src/a.ts")).toBe("allow") // the remembered rule
    expect(run("ask", "src/a.ts", [parseRule("Edit(**)", "allow", "test")!])).toBe("allow")
    expect(run("ask", ".git/config", [parseRule("Edit(**)", "allow", "test")!])).toBe("ask")
  })

  test("Penuh keeps its documented meaning (the file tools still force a prompt there)", () => {
    expect(run("full", ".git/config")).toBe("allow")
  })
})

describe("web_search in the relaxed modes", () => {
  const run = (mode: DecideInput["mode"], trusted = true) =>
    decide({
      mode,
      trusted,
      permission: "web_search",
      pattern: "*",
      base: { action: "ask", fromDefaults: true },
      rules: [],
      root,
      worktree: root,
      flags: { modes: true, rules: true },
    }).action

  test("asks in Tanya dulu and in untrusted folders, runs in Edit otomatis / Otomatis-aman / Penuh", () => {
    expect(run("ask")).toBe("ask")
    expect(run("acceptEdits", false)).toBe("ask")
    expect(run("acceptEdits")).toBe("allow")
    expect(run("safeAuto")).toBe("allow")
    expect(run("full")).toBe("allow")
    expect(run("plan")).toBe("ask")
  })
})
