// Security matrix for the Wave B permission layer: mode × trust × path × command.
// Invariants checked for every cell:
//   1. an untrusted folder never gets more than the "ask" mode gives (no relaxing at all);
//   2. a deny from the upstream ruleset is never relaxed; an explicit (non-default) ask is never relaxed;
//   3. edits outside the project or on protected paths ask in every mode except Penuh (full);
//   4. Rencana (plan) never allows an edit or a non-read-only command, trusted or not (not even after an approval).
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { decide, type DecideInput } from "../../src/ezk/safety/decide"
import { MODES, effectiveMode, nextMode, parseMode, type Mode } from "../../src/ezk/safety/modes"
import { parseRule } from "../../src/ezk/safety/rules"

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ezk-matrix-")))
const root = path.join(base, "project")
fs.mkdirSync(path.join(root, "src"), { recursive: true })
fs.mkdirSync(path.join(base, "outside"), { recursive: true })
fs.symlinkSync(path.join(base, "outside"), path.join(root, "link-out"))
afterAll(() => fs.rmSync(base, { recursive: true, force: true }))

const rules = [parseRule("Bash(bun test *)", "allow")!, parseRule("Bash(curl *)", "deny")!, parseRule("Bash(git push *)", "ask")!]

const run = (over: Partial<DecideInput> & Pick<DecideInput, "mode" | "trusted" | "permission" | "pattern">) =>
  decide({ base: { action: "ask", fromDefaults: true }, rules, root, worktree: root, flags: { modes: true, rules: true }, ...over }).action

const EDITS = {
  inside: "src/a.ts",
  newFile: "src/new/deep/file.ts",
  outside: "../outside/x.ts",
  symlinkOut: "link-out/x.ts",
  git: ".git/config",
  ezkConfig: ".ezkielyna/settings.local.json",
  claude: ".claude/settings.json",
  env: ".env",
  envLocal: "config/.env.local",
} as const

const COMMANDS = {
  readonly: "ls -la",
  gitStatus: "git status",
  catInside: "cat src/a.ts",
  catOutside: "cat /etc/passwd",
  remembered: "bun test src",
  compound: "bun test; rm -rf ~",
  substitution: "bun test $(rm -rf ~)",
  denied: "curl https://x.io",
  explicitAsk: "git push origin main",
  unknown: "make deploy",
} as const

describe("modes", () => {
  test("labels, aliases and cycling", () => {
    expect(parseMode("default")).toBe("ask")
    expect(parseMode("bypassPermissions")).toBe("full")
    expect(parseMode("Edit otomatis")).toBe("acceptEdits")
    expect(parseMode("nope")).toBeUndefined()
    expect(nextMode("ask")).toBe("acceptEdits")
    expect(nextMode("safeAuto")).toBe("ask")
    expect(nextMode("full")).toBe("ask")
    expect(nextMode("ask", true)).toBe("safeAuto")
  })
  test("untrusted folders are forced to ask; plan stays because it only restricts", () => {
    for (const mode of MODES) expect(effectiveMode(mode, false)).toBe(mode === "plan" ? "plan" : "ask")
  })
})

describe("matrix: edits", () => {
  const expected: Record<Mode, Record<keyof typeof EDITS, "allow" | "ask" | "deny">> = {
    ask: { inside: "ask", newFile: "ask", outside: "ask", symlinkOut: "ask", git: "ask", ezkConfig: "ask", claude: "ask", env: "ask", envLocal: "ask" },
    acceptEdits: { inside: "allow", newFile: "allow", outside: "ask", symlinkOut: "ask", git: "ask", ezkConfig: "ask", claude: "ask", env: "ask", envLocal: "ask" },
    safeAuto: { inside: "allow", newFile: "allow", outside: "ask", symlinkOut: "ask", git: "ask", ezkConfig: "ask", claude: "ask", env: "ask", envLocal: "ask" },
    plan: { inside: "deny", newFile: "deny", outside: "deny", symlinkOut: "deny", git: "deny", ezkConfig: "deny", claude: "deny", env: "deny", envLocal: "deny" },
    full: { inside: "allow", newFile: "allow", outside: "allow", symlinkOut: "allow", git: "allow", ezkConfig: "allow", claude: "allow", env: "allow", envLocal: "allow" },
  }
  for (const mode of MODES)
    for (const [name, pattern] of Object.entries(EDITS)) {
      const key = name as keyof typeof EDITS
      test(`${mode} × trusted × edit ${name}`, () => {
        expect(run({ mode, trusted: true, permission: "edit", pattern })).toBe(expected[mode][key])
      })
      test(`${mode} × untrusted × edit ${name}`, () => {
        expect(run({ mode, trusted: false, permission: "edit", pattern })).toBe(mode === "plan" ? "deny" : "ask")
      })
    }
})

describe("matrix: commands", () => {
  const expected: Record<Mode, Record<keyof typeof COMMANDS, "allow" | "ask" | "deny">> = {
    ask: { readonly: "allow", gitStatus: "allow", catInside: "allow", catOutside: "ask", remembered: "allow", compound: "ask", substitution: "ask", denied: "deny", explicitAsk: "ask", unknown: "ask" },
    acceptEdits: { readonly: "allow", gitStatus: "allow", catInside: "allow", catOutside: "ask", remembered: "allow", compound: "ask", substitution: "ask", denied: "deny", explicitAsk: "ask", unknown: "ask" },
    safeAuto: { readonly: "allow", gitStatus: "allow", catInside: "allow", catOutside: "ask", remembered: "allow", compound: "ask", substitution: "ask", denied: "deny", explicitAsk: "ask", unknown: "ask" },
    plan: { readonly: "allow", gitStatus: "allow", catInside: "allow", catOutside: "deny", remembered: "deny", compound: "deny", substitution: "deny", denied: "deny", explicitAsk: "deny", unknown: "deny" },
    full: { readonly: "allow", gitStatus: "allow", catInside: "allow", catOutside: "allow", remembered: "allow", compound: "allow", substitution: "allow", denied: "deny", explicitAsk: "ask", unknown: "allow" },
  }
  for (const mode of MODES)
    for (const [name, pattern] of Object.entries(COMMANDS)) {
      const key = name as keyof typeof COMMANDS
      test(`${mode} × trusted × ${name}`, () => {
        expect(run({ mode, trusted: true, permission: "bash", pattern })).toBe(expected[mode][key])
      })
    }

  test("untrusted: every mode gives what ask-first gives (deny/ask rules still apply, nothing relaxes)", () => {
    for (const mode of MODES)
      for (const [name, pattern] of Object.entries(COMMANDS)) {
        const got = run({ mode, trusted: false, permission: "bash", pattern })
        // in plan, only read-only commands survive (git reads are read-only only in trusted folders); nothing is allowed outright
        const readOnlyUntrusted = ["readonly", "catInside"].includes(name)
        const want = name === "denied" ? "deny" : mode === "plan" && !readOnlyUntrusted ? "deny" : "ask"
        expect(`${mode}:${name}:${got}`).toBe(`${mode}:${name}:${want}`)
      }
  })
})

describe("invariants", () => {
  test("a deny from the ruleset is never relaxed, in any mode or trust", () => {
    for (const mode of MODES)
      for (const trusted of [true, false])
        for (const permission of ["edit", "bash", "webfetch", "external_directory"])
          expect(run({ mode, trusted, permission, pattern: "src/a.ts", base: { action: "deny", fromDefaults: true } })).toBe("deny")
  })

  test("an ask the user or an agent wrote is never relaxed, even in full", () => {
    for (const mode of MODES)
      for (const permission of ["edit", "bash", "webfetch"])
        expect(run({ mode, trusted: true, permission, pattern: "src/a.ts", base: { action: "ask", fromDefaults: false } })).not.toBe("allow")
  })

  test("flags off: decisions equal the upstream ruleset (today's behaviour)", () => {
    for (const mode of MODES)
      for (const action of ["allow", "ask", "deny"] as const)
        for (const pattern of [...Object.values(EDITS), ...Object.values(COMMANDS)])
          for (const permission of ["edit", "bash"])
            expect(decide({ mode, trusted: true, permission, pattern, base: { action, fromDefaults: true }, rules, root, worktree: root, flags: { modes: false, rules: false } }).action).toBe(action)
  })

  test("web access and outside-folder access ask in every mode except full", () => {
    for (const mode of MODES)
      for (const permission of ["webfetch", "external_directory"]) {
        const got = run({ mode, trusted: true, permission, pattern: "https://example.com" })
        expect(got).toBe(mode === "full" ? "allow" : "ask")
      }
  })

  test("non-git folder (worktree /): inside means inside the opened folder", () => {
    const rel = path.relative("/", path.join(root, "src/a.ts"))
    expect(decide({ mode: "acceptEdits", trusted: true, permission: "edit", pattern: rel, base: { action: "ask", fromDefaults: true }, rules: [], root, worktree: "/", flags: { modes: true, rules: false } }).action).toBe("allow")
    const out = path.relative("/", path.join(base, "outside/x.ts"))
    expect(decide({ mode: "acceptEdits", trusted: true, permission: "edit", pattern: out, base: { action: "ask", fromDefaults: true }, rules: [], root, worktree: "/", flags: { modes: true, rules: false } }).action).toBe("ask")
  })
})
